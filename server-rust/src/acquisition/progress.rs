use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::{Instant, MissedTickBehavior};

use super::playlist_timeout::{PlaylistDeadline, PlaylistProgress};
use super::spotdl::{
    AcquisitionProgress, DownloadOutput, SpotDLDownloadError, SpotDLDownloaderAdapter,
    TrackImportRequest, saved_track_errors,
};
use crate::tasks::{ProcessError, TaskError, TaskProgressPatch, TaskRunContext};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackIssue {
    pub position: usize,
    pub title: String,
    pub code: String,
    pub message: String,
}

pub(super) fn safe_title(value: &str) -> String {
    if value.contains("://") || value.contains('\\') || value.starts_with('/') {
        return String::new();
    }
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(160)
        .collect()
}

#[derive(Clone, Default, PartialEq)]
pub(super) struct DownloadTelemetry {
    pub stage: &'static str,
    pub expected: Option<usize>,
    pub discovered: Option<usize>,
    pub downloaded: usize,
    pub finished: usize,
    pub percent: Option<f64>,
    pub bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed: Option<u64>,
}

impl DownloadTelemetry {
    fn observe(&mut self, update: &AcquisitionProgress, deadline: &mut Option<PlaylistDeadline>) {
        let now = Instant::now();
        if let Some(message) = &update.message
            && let Some(progress) = PlaylistProgress::from_log(message)
        {
            if let Some(deadline) = deadline {
                deadline.observe(progress, now);
            }
            match progress {
                PlaylistProgress::TrackCount(count) => self.expected = Some(count as usize),
                PlaylistProgress::TrackFinished => {
                    self.finished += 1;
                    if !message.contains(": Error") {
                        self.downloaded += 1;
                    }
                }
            }
        }
        if let Some(stage) = update.stage.as_deref() {
            match stage {
                "converting" | "tagging" => self.stage = "conversion",
                "downloading" => self.stage = "download",
                "provider_cooldown" => self.stage = "provider_cooldown",
                _ => {}
            }
        }
        if let Some(bytes) = update.bytes_downloaded {
            if self.bytes != Some(bytes)
                && let Some(deadline) = deadline
            {
                deadline.activity(now);
            }
            self.bytes = Some(bytes);
        }
        self.total_bytes = update.total_bytes.or(self.total_bytes);
        self.speed = update.speed_bytes_per_second.or(self.speed);
        let percent = self
            .expected
            .map(|count| 80.0 * self.finished as f64 / count as f64)
            .or_else(|| update.percent.map(|p| p * 0.8));
        if let Some(percent) = percent {
            self.percent = Some(self.percent.unwrap_or(0.0).max(percent.min(80.0)));
        }
    }
}

pub(super) fn is_transient_provider_error(code: &str) -> bool {
    matches!(
        code,
        "provider-network" | "provider-timeout" | "rate-limited"
    )
}

#[derive(Default)]
pub(super) struct ProviderRetries {
    attempts: u8,
    rate_limit_retried: bool,
}

impl ProviderRetries {
    pub async fn wait<F>(
        &mut self,
        context: &TaskRunContext,
        end: Instant,
        code: &str,
        report: impl FnOnce(&'static str) -> F,
    ) -> Result<bool, TaskError>
    where
        F: Future<Output = ()>,
    {
        if self.attempts >= 2 || !is_transient_provider_error(code) {
            return Ok(false);
        }
        let rate_limited = code == "rate-limited";
        if rate_limited && self.rate_limit_retried {
            return Ok(false);
        }
        let delay = if rate_limited { 60 } else { 2 << self.attempts };
        let retry_at = Instant::now() + Duration::from_secs(delay);
        if retry_at + Duration::from_secs(1) >= end {
            return Ok(false);
        }
        self.attempts += 1;
        self.rate_limit_retried |= rate_limited;
        let stage = if rate_limited {
            "provider_cooldown"
        } else {
            "retry_wait"
        };
        let cancel = context.cancel_token();
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(TaskError::Cancelled),
            () = async {
                let _ = tokio::time::timeout(Duration::from_secs(1), report(stage)).await;
                tokio::time::sleep_until(retry_at).await;
            } => Ok(true),
        }
    }
}

fn task_error(error: SpotDLDownloadError) -> TaskError {
    match error {
        SpotDLDownloadError::Process(ProcessError::Cancelled) => TaskError::Cancelled,
        other => TaskError::ExecutionFailed(other.to_string()),
    }
}

pub(super) async fn monitor_download<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    request: &TrackImportRequest,
    deadline: Option<PlaylistDeadline>,
    hard_deadline: Instant,
    mut persist: impl FnMut(DownloadTelemetry) -> F,
) -> Result<DownloadOutput, TaskError>
where
    F: Future<Output = ()> + Send,
{
    let snapshot = Arc::new(Mutex::new((
        DownloadTelemetry {
            stage: "download",
            ..Default::default()
        },
        deadline,
    )));
    let reporter = Arc::clone(&snapshot);
    let started = std::time::SystemTime::now();
    let cancel = context.cancel_token().child_token();
    let work = downloader.download_with_cancel(request, cancel.clone(), move |update| {
        let mut data = reporter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (telemetry, deadline) = &mut *data;
        telemetry.observe(&update, deadline);
    });
    tokio::pin!(work);
    let context_cancel = context.cancel_token();
    let mut interval = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(1),
        Duration::from_secs(1),
    );
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last = None;
    loop {
        let interrupted = tokio::select! {
            biased;
            () = context_cancel.cancelled() => Some(None),
            () = tokio::time::sleep_until(hard_deadline) => Some(Some("The download reached its time limit")),
            result = &mut work => return result.map_err(task_error),
            _ = interval.tick() => None,
        };
        let (telemetry, elapsed) = {
            let data = snapshot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                data.0.clone(),
                data.1
                    .as_ref()
                    .map(PlaylistDeadline::next)
                    .filter(|(when, _)| *when <= Instant::now()),
            )
        };
        if let Some(reason) = interrupted.or_else(|| elapsed.map(|(_, message)| Some(message))) {
            cancel.cancel();
            // The runner is polled through cleanup, with a fallback to its process-tree drop guard.
            let _ = tokio::time::timeout(Duration::from_secs(3), &mut work).await;
            let Some(message) = reason else {
                return Err(TaskError::Cancelled);
            };
            let track_errors = saved_track_errors(&request.output_directory, started).await;
            let files = super::spotdl::scan_downloaded_audio_files(&request.output_directory)
                .await
                .map_err(|_| {
                    TaskError::ExecutionFailed("Could not read staged audio after timeout".into())
                })?;
            return Ok(DownloadOutput {
                files,
                track_errors,
                failure: Some(SpotDLDownloadError::Download(format!(
                    "spotDL failed (download-timeout): {message}. Retry to resume missing tracks."
                ))),
            });
        }
        if last.as_ref() != Some(&telemetry) {
            last = Some(telemetry.clone());
            let message = match telemetry.stage {
                "conversion" => "Converting audio",
                "provider_cooldown" => "Waiting for the source provider cooldown",
                _ => "Downloading audio",
            };
            let update = context.report(TaskProgressPatch {
                message: Some(Some(message.into())),
                percent: telemetry.percent,
                items_processed: Some(telemetry.downloaded as u64),
                total_items: telemetry.expected.map(|count| Some(count as u64)),
                ..Default::default()
            });
            tokio::select! {
                () = context_cancel.cancelled() => {},
                _ = tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(persist(telemetry), update); }) => {},
                result = &mut work => return result.map_err(task_error),
            }
        }
    }
}
