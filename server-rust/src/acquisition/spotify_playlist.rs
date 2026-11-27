use std::{future::Future, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{fs, time::Instant};

use super::{
    playlist_files::read_playlist_artifact, playlist_timeout::within_phase,
    progress::DownloadTelemetry, repository::ManifestDownload, resume,
    spotdl::SpotDLDownloaderAdapter,
};
use crate::tasks::{TaskError, TaskProgressPatch, TaskRunContext};

pub(super) const BRIDGE: &str = include_str!("spotify_playlist.py");
const PAGE_SIZE: usize = 100;
const MAX_ATTEMPTS: u32 = 3;
const TIMEOUT: Duration = Duration::from_secs(20 * 60);
const COOLDOWN_KEY: &str = "spotify-playlist";
const PAGES_DIR: &str = "spotify-pages";

#[derive(Deserialize, Serialize)]
pub(super) struct Page {
    offset: usize,
    total: usize,
    name: Option<String>,
    revision: Option<String>,
    items: Vec<PageItem>,
}

#[derive(Deserialize, Serialize)]
struct PageItem {
    key: String,
    song: Option<Value>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum PageResponse {
    Read {
        page: Page,
    },
    Failed {
        error: String,
        retry_after: Option<u64>,
    },
}

#[derive(Default)]
struct Discovery {
    total: Option<usize>,
    name: Option<String>,
    revision: Option<String>,
    last_key: Option<String>,
    rows: Vec<Value>,
}

#[derive(Debug, thiserror::Error)]
enum PageError {
    #[error("Spotify returned an invalid playlist page or track count")]
    Invalid,
    #[error("Spotify returned an incomplete playlist page")]
    Incomplete,
    #[error(
        "The Spotify playlist changed during discovery. Submit the same link to start discovery again."
    )]
    Changed,
}

fn error(message: impl Into<String>) -> TaskError {
    TaskError::ExecutionFailed(message.into())
}

impl Discovery {
    fn request(&self) -> (usize, usize) {
        // Re-read the last position to detect a shifted playlist on later pages or restart.
        (
            self.rows.len().saturating_sub(1),
            PAGE_SIZE + usize::from(!self.rows.is_empty()),
        )
    }

    fn complete(&self) -> bool {
        self.total == Some(self.rows.len())
    }

    fn append(&mut self, page: Page) -> Result<(), PageError> {
        let (offset, limit) = self.request();
        if page.offset != offset || page.total > resume::MAX_OCCURRENCES {
            return Err(PageError::Invalid);
        }
        if let Some(total) = self.total {
            if total != page.total
                || self.revision != page.revision
                || page.items.first().map(|item| &item.key) != self.last_key.as_ref()
            {
                return Err(PageError::Changed);
            }
        }
        if page.items.len() != limit.min(page.total.saturating_sub(offset)) {
            return Err(PageError::Incomplete);
        }
        self.total = Some(page.total);
        self.name = self.name.take().or(page.name);
        self.revision = page.revision;
        self.last_key = page.items.last().map(|item| item.key.clone());
        let overlap = usize::from(!self.rows.is_empty());
        for item in page.items.into_iter().skip(overlap) {
            let mut row = item.song.unwrap_or_else(|| json!({}));
            let object = row.as_object_mut().ok_or(PageError::Invalid)?;
            object.insert("list_position".into(), json!(self.rows.len() + 1));
            object.insert("list_length".into(), json!(page.total));
            self.rows.push(row);
        }
        Ok(())
    }
}

pub(super) async fn has_checkpoint(stage: &Path) -> bool {
    fs::symlink_metadata(stage.join(PAGES_DIR).join("0.json"))
        .await
        .is_ok_and(|metadata| metadata.is_file())
}

async fn load(stage: &Path) -> Result<Discovery, TaskError> {
    let directory = stage.join(PAGES_DIR);
    let mut state = Discovery::default();
    while !state.complete() {
        let path = directory.join(format!("{}.json", state.rows.len()));
        match read_playlist_artifact(&path).await {
            Ok(value) => state
                .append(
                    serde_json::from_str(&value)
                        .map_err(|_| error("Could not read the Spotify playlist checkpoint"))?,
                )
                .map_err(|failure| error(failure.to_string()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err(error("Could not open the Spotify playlist checkpoint")),
        }
    }
    Ok(state)
}

pub(super) async fn saved_songs(stage: &Path) -> Result<Option<Vec<Value>>, TaskError> {
    if !has_checkpoint(stage).await {
        return Ok(None);
    }
    let state = load(stage).await?;
    if !state.complete() {
        return Err(error("The Spotify playlist checkpoint is incomplete"));
    }
    Ok(Some(state.rows))
}

async fn report_progress<F>(
    context: &TaskRunContext,
    report: &impl Fn(DownloadTelemetry) -> F,
    state: &Discovery,
    message: Option<&str>,
) where
    F: Future<Output = ()> + Send,
{
    let discovered = state.rows.len();
    let message = message
        .map(str::to_owned)
        .unwrap_or_else(|| match state.total {
            Some(total) => format!("{discovered} of {total} tracks discovered"),
            None => "Discovering source tracks".into(),
        });
    tokio::join!(
        report(DownloadTelemetry {
            stage: "discovering",
            expected: state.total,
            discovered: Some(discovered),
            ..Default::default()
        }),
        context.report(TaskProgressPatch {
            message: Some(Some(message)),
            items_processed: Some(discovered as u64),
            total_items: state.total.map(|total| Some(total as u64)),
            ..Default::default()
        }),
    );
}

async fn wait_for_cooldown<F>(
    context: &TaskRunContext,
    end: Instant,
    state: &Discovery,
    report: &impl Fn(DownloadTelemetry) -> F,
) -> Result<(), TaskError>
where
    F: Future<Output = ()> + Send,
{
    let Some(db) = context.db() else {
        return Ok(());
    };
    loop {
        let until: Option<i64> = sqlx::query_scalar(
            "SELECT blocked_until FROM acquisition_provider_cooldown WHERE provider=?",
        )
        .bind(COOLDOWN_KEY)
        .fetch_optional(db.inner())
        .await
        .map_err(|_| error("Could not check the Spotify playlist cooldown"))?;
        let now = chrono::Utc::now().timestamp_millis();
        let Some(until) = until.filter(|until| *until > now) else {
            return Ok(());
        };
        let delay = Duration::from_millis(until.saturating_sub(now) as u64);
        if delay >= end.saturating_duration_since(Instant::now()) {
            return Err(error(
                "Spotify is rate limiting playlist discovery. Submit the same link after the cooldown to resume.",
            ));
        }
        report_progress(
            context,
            report,
            state,
            Some("Waiting for the Spotify playlist cooldown"),
        )
        .await;
        tokio::time::sleep(delay).await;
    }
}

async fn read_page<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    playlist_id: &str,
    stage: &Path,
    end: Instant,
    state: &Discovery,
    report: &impl Fn(DownloadTelemetry) -> F,
) -> Result<Page, TaskError>
where
    F: Future<Output = ()> + Send,
{
    let (offset, limit) = state.request();
    for attempt in 0..MAX_ATTEMPTS {
        wait_for_cooldown(context, end, state, report).await?;
        match downloader
            .spotify_playlist_page(stage, playlist_id, offset, limit, context.cancel_token())
            .await?
        {
            PageResponse::Read { page } => return Ok(page),
            PageResponse::Failed {
                error: code,
                retry_after,
            } => {
                let delay = match code.as_str() {
                    "rate-limited" => {
                        let seconds = retry_after.unwrap_or(60).max(1);
                        if let Some(db) = context.db() {
                            let until = chrono::Utc::now().timestamp_millis().saturating_add(
                                seconds.saturating_mul(1000).min(i64::MAX as u64) as i64,
                            );
                            sqlx::query("INSERT INTO acquisition_provider_cooldown VALUES (?, ?, 1)
                                ON CONFLICT(provider) DO UPDATE SET blocked_until=MAX(blocked_until, excluded.blocked_until)")
                                .bind(COOLDOWN_KEY).bind(until).execute(db.inner()).await
                                .map_err(|_| error("Could not save the Spotify playlist cooldown"))?;
                            // Recheck the shared cooldown before the next attempt.
                            Duration::ZERO
                        } else {
                            Duration::from_secs(seconds)
                        }
                    }
                    "provider-network" | "provider-timeout" => Duration::from_secs(2 << attempt),
                    "playlist-unavailable" => {
                        return Err(error(
                            "Spotify did not allow access to this playlist. Check that the link is public.",
                        ));
                    }
                    _ => {
                        return Err(error(
                            "Spotify returned an invalid response while reading the playlist",
                        ));
                    }
                };
                if attempt + 1 == MAX_ATTEMPTS
                    || delay >= end.saturating_duration_since(Instant::now())
                {
                    return Err(error(format!(
                        "Could not read the Spotify playlist page at track {} ({code}). Submit the same link to resume.",
                        state.rows.len() + 1
                    )));
                }
                if !delay.is_zero() {
                    report_progress(
                        context,
                        report,
                        state,
                        Some("Waiting to retry the Spotify playlist page"),
                    )
                    .await;
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    unreachable!("page attempts return a result")
}

pub(super) async fn discover<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    stage: &Path,
    playlist_id: &str,
    end: Instant,
    report: impl Fn(DownloadTelemetry) -> F,
) -> Result<ManifestDownload, TaskError>
where
    F: Future<Output = ()> + Send,
{
    let end = end.min(Instant::now() + TIMEOUT);
    within_phase(
        context,
        end,
        "source discovery",
        downloader.check_playlist_downloader(context.cancel_token()),
    )
    .await?;
    let directory = stage.join(PAGES_DIR);
    fs::create_dir_all(&directory)
        .await
        .map_err(|_| error("Could not create the Spotify playlist checkpoint folder"))?;
    let mut state = load(stage).await?;
    report_progress(context, &report, &state, None).await;
    while !state.complete() {
        context.checkpoint().await?;
        let page = within_phase(
            context,
            end,
            "source discovery",
            read_page(
                context,
                downloader,
                playlist_id,
                stage,
                end,
                &state,
                &report,
            ),
        )
        .await?;
        let path = directory.join(format!("{}.json", state.rows.len()));
        let bytes = serde_json::to_vec(&page)
            .map_err(|_| error("Could not encode the Spotify playlist page"))?;
        if let Err(failure) = state.append(page) {
            // A shifted source cannot safely reuse earlier page positions on another attempt.
            if matches!(failure, PageError::Changed) {
                fs::remove_dir_all(&directory).await.map_err(|_| {
                    error("Could not reset the changed Spotify playlist checkpoint")
                })?;
            }
            return Err(error(failure.to_string()));
        }
        tokio::task::spawn_blocking(move || crate::config::durable_bytes(&path, &bytes))
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| error("Could not save the Spotify playlist page"))?;
        report_progress(context, &report, &state, None).await;
    }
    let mut manifest = resume::occurrence_manifest(
        &serde_json::to_string(&state.rows)
            .map_err(|_| error("Could not encode the Spotify playlist manifest"))?,
        true,
    )?;
    manifest.name = state.name.map(|name| name.chars().take(200).collect());
    resume::save(stage, &manifest).await?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(offset: usize, count: usize, revision: &str) -> Page {
        Page {
            offset,
            total: 150,
            name: Some("Fixture".into()),
            revision: Some(revision.into()),
            items: (offset..offset + count)
                .map(|position| PageItem {
                    key: position.to_string(),
                    song: None,
                })
                .collect(),
        }
    }

    #[test]
    fn rejects_truncated_pages_and_changed_playlist_boundaries() {
        let mut discovery = Discovery::default();
        assert!(matches!(
            discovery.append(page(0, 99, "one")),
            Err(PageError::Incomplete)
        ));
        discovery.append(page(0, 100, "one")).unwrap();
        assert!(matches!(
            discovery.append(page(99, 51, "two")),
            Err(PageError::Changed)
        ));
        let mut shifted = page(99, 51, "one");
        shifted.items[0].key = "shifted".into();
        assert!(matches!(discovery.append(shifted), Err(PageError::Changed)));
        assert_eq!(discovery.rows.len(), 100);
        discovery.append(page(99, 51, "one")).unwrap();
        assert!(discovery.complete());
        assert_eq!(discovery.rows.last().unwrap()["list_position"], 150);
    }
}
