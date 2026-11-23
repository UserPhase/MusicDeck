use std::{io, time::Duration};

use chrono::{TimeDelta, Utc};
use tokio::fs;

use crate::{config::AppConfig, db::DbPool, tasks::TaskManager};

fn job_directory(name: &str) -> Option<(&str, Option<String>)> {
    let id = |value: &str, prefix: &str| {
        value.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.len() == 16
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    };
    if id(name, "spimp_") {
        return Some((name, None));
    }
    let (job, attempt) = name.split_at_checked(20)?;
    let attempt = attempt.strip_prefix('-')?;
    (id(job, "acq_") && id(attempt, "task_")).then(|| (job, Some(attempt.to_owned())))
}

fn is_plain_directory(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_dir() && !metadata.is_symlink()
}

pub(super) async fn prune(
    db: &DbPool,
    config: &AppConfig,
    tasks: &TaskManager,
) -> Result<(), String> {
    let limits = &config.acquisition_limits;
    let cutoff = Utc::now()
        .checked_sub_signed(TimeDelta::milliseconds(
            limits.retention_ms.min(i64::MAX as u64 / 2) as i64,
        ))
        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC)
        .to_rfc3339();
    let keep = limits.max_retained_jobs.min(i64::MAX as u64) as i64;
    for (table, terminal) in [
        (
            "acquisition_jobs",
            "'completed','partial','failed','cancelled'",
        ),
        ("import_jobs", "'COMPLETED','FAILED'"),
    ] {
        // Both identifiers and status sets are constants. A single statement rechecks
        // terminal state while deleting, so admissions/retries cannot race the sweep.
        sqlx::query(&format!("DELETE FROM {table} WHERE status IN ({terminal}) AND (
            updated_at<?1 OR id IN (SELECT id FROM {table} WHERE status IN ({terminal}) ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?2))"))
            .bind(&cutoff).bind(keep).execute(db.inner()).await.map_err(|err| err.to_string())?;
    }
    prune_staging(db, config, tasks, &cutoff).await
}

async fn prune_staging(
    db: &DbPool,
    config: &AppConfig,
    tasks: &TaskManager,
    cutoff: &str,
) -> Result<(), String> {
    let result = async {
        let root = match fs::canonicalize(&config.acquisition_tmp_dir).await {
            Ok(root) if root.parent().is_some() => root,
            Ok(_) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        };
        if let Ok(music) = fs::canonicalize(&config.music_root).await
            && (music.starts_with(&root) || root.starts_with(&music)) {
            return Ok(());
        }
        let mut entries = fs::read_dir(&root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path).await else { continue; };
            if !is_plain_directory(&metadata) { continue; }
            if name.starts_with(".musicdeck-expired-") && name.len() == ".musicdeck-expired-".len() + 32
                && name[".musicdeck-expired-".len()..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
                super::playlist_files::cleanup_staging(&path).await;
                continue;
            }
            let Some((job, attempt)) = job_directory(name) else { continue; };
            if metadata.modified()?.elapsed().unwrap_or_default() < Duration::from_millis(config.acquisition_limits.retention_ms) {
                continue;
            }
            let mut tx = crate::db::begin_sqlite_write(db.inner(), "UPDATE import_jobs SET status=status WHERE 0")
                .await.map_err(io::Error::other)?;
            let busy: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM import_jobs WHERE id=?1 AND (status IN ('PENDING','PROCESSING') OR updated_at>=?2)
                 UNION ALL SELECT 1 FROM acquisition_jobs WHERE id=?1 AND (status IN ('queued','discovering','downloading','processing','importing') OR updated_at>=?2))",
            ).bind(job).bind(cutoff).fetch_one(&mut *tx).await.map_err(io::Error::other)?;
            let task_ids: Vec<String> = if let Some(attempt) = attempt { vec![attempt] } else {
                sqlx::query_scalar("SELECT id FROM background_tasks WHERE type='SPOTDL_IMPORT' AND payload_json=?")
                    .bind(serde_json::json!({ "kind": "playlist", "jobId": job }).to_string())
                    .fetch_all(&mut *tx).await.map_err(io::Error::other)?
            };
            if busy || task_ids.iter().any(|id| tasks.is_executing(id)) { continue; }
            // Move the expired attempt out of its working path while holding the writer
            // lock. Recursive cleanup runs after releasing it.
            let expired = root.join(format!(".musicdeck-expired-{}", uuid::Uuid::new_v4().simple()));
            let removed = fs::rename(path, &expired).await.is_ok();
            tx.commit().await.map_err(io::Error::other)?;
            if removed { super::playlist_files::cleanup_staging(&expired).await; }
        }
        Ok::<(), io::Error>(())
    }.await;
    result.map_err(|err| err.to_string())
}
