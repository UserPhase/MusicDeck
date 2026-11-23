use chrono::Utc;
use sqlx::{Row, SqliteConnection};
use tokio_util::sync::CancellationToken;

use crate::{config::AcquisitionLimits, db::DbPool, tasks::ProcessError};

/// Checks capacity and records a submission inside the same SQLite writer transaction
/// that enqueues the task. Callers that roll back do not consume a rate slot.
pub(super) async fn admit(
    connection: &mut SqliteConnection,
    user_id: &str,
    limits: AcquisitionLimits,
) -> Result<(), String> {
    let storage = |err: sqlx::Error| format!("STORAGE:{err}");
    let now = Utc::now().timestamp_millis();
    let blocked_until: Option<i64> = sqlx::query_scalar(
        "SELECT blocked_until FROM acquisition_provider_cooldown WHERE provider='spotdl'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(storage)?;
    if let Some(retry_after) = blocked_until.filter(|end| *end > now) {
        return Err(format!(
            "CAPACITY:{}",
            ((retry_after - now) as u64).div_ceil(1000)
        ));
    }
    let counts = sqlx::query(
        "SELECT COUNT(*) AS global, COUNT(CASE WHEN user_id=? THEN 1 END) AS own FROM (
           SELECT user_id FROM acquisition_jobs WHERE status IN ('queued','discovering','downloading','processing','importing')
           UNION ALL SELECT user_id FROM import_jobs WHERE status IN ('PENDING','PROCESSING')
         )",
    ).bind(user_id).fetch_one(&mut *connection).await.map_err(storage)?;
    if counts.get::<i64, _>("global") as u64 >= limits.max_pending
        || counts.get::<i64, _>("own") as u64 >= limits.max_pending_per_user
    {
        return Err("CAPACITY:60".into());
    }

    let cutoff = now.saturating_sub(limits.submission_window_ms.min(i64::MAX as u64) as i64);
    let counts = sqlx::query(
        "SELECT COUNT(*) AS global, COUNT(CASE WHEN user_id=? THEN 1 END) AS own,
                MIN(submitted_at) AS first, MIN(CASE WHEN user_id=? THEN submitted_at END) AS first_own
         FROM acquisition_submissions WHERE submitted_at>?",
    ).bind(user_id).bind(user_id).bind(cutoff).fetch_one(&mut *connection).await.map_err(storage)?;
    let global_full = counts.get::<i64, _>("global") as u64
        >= limits.submissions_global.min(limits.max_rate_entries);
    let own_full = counts.get::<i64, _>("own") as u64 >= limits.submissions_per_user;
    if global_full || own_full {
        let global_wait = global_full.then(|| counts.get::<Option<i64>, _>("first").unwrap_or(now));
        let own_wait = own_full.then(|| counts.get::<Option<i64>, _>("first_own").unwrap_or(now));
        let oldest = global_wait.into_iter().chain(own_wait).max().unwrap_or(now);
        return Err(format!(
            "CAPACITY:{}",
            (oldest.saturating_sub(cutoff).max(1) as u64).div_ceil(1000)
        ));
    }
    sqlx::query("DELETE FROM acquisition_submissions WHERE submitted_at<=?")
        .bind(cutoff)
        .execute(&mut *connection)
        .await
        .map_err(storage)?;
    sqlx::query("INSERT INTO acquisition_submissions (user_id, submitted_at) VALUES (?,?)")
        .bind(user_id)
        .bind(now)
        .execute(connection)
        .await
        .map_err(storage)?;
    Ok(())
}

/// Queued jobs honor cooldowns established by earlier invocations and can be cancelled while waiting.
pub(super) async fn wait_for_provider<F>(
    db: &DbPool,
    cancel: &CancellationToken,
    mut on_wait: impl FnMut() -> F,
) -> Result<(), ProcessError>
where
    F: std::future::Future<Output = ()>,
{
    loop {
        let blocked_until: Option<i64> = tokio::select! {
            () = cancel.cancelled() => return Err(ProcessError::Cancelled),
            result = sqlx::query_scalar("SELECT blocked_until FROM acquisition_provider_cooldown WHERE provider='spotdl'")
                .fetch_optional(db.inner()) => result.map_err(|_| ProcessError::Io("Could not check downloader cooldown".into()))?,
        };
        let now = Utc::now().timestamp_millis();
        let Some(end) = blocked_until.filter(|end| *end > now) else {
            return Ok(());
        };
        tokio::select! {
            () = cancel.cancelled() => return Err(ProcessError::Cancelled),
            _ = on_wait() => {}
        }
        tokio::select! {
            () = cancel.cancelled() => return Err(ProcessError::Cancelled),
            () = tokio::time::sleep(std::time::Duration::from_millis((end - now) as u64)) => {},
        }
    }
}

pub(super) async fn note_provider_failure(db: &DbPool, code: &str) {
    let base = match code {
        "rate-limited" | "bot-challenge" => 60_000_i64,
        "provider-forbidden" => 30_000_i64,
        _ => return,
    };
    let now = Utc::now().timestamp_millis();
    let result = sqlx::query(
        "INSERT INTO acquisition_provider_cooldown VALUES ('spotdl',?1+?2,1)
         ON CONFLICT(provider) DO UPDATE SET
           blocked_until=MAX(blocked_until, ?1+?2*(1 << CASE WHEN blocked_until>?1-600000 THEN MIN(recent_failures,3) ELSE 0 END)),
           recent_failures=CASE WHEN blocked_until>?1-600000 THEN MIN(recent_failures+1,4) ELSE 1 END",
    ).bind(now).bind(base).execute(db.inner()).await;
    if let Err(error) = result {
        tracing::warn!(%error, "Could not persist downloader cooldown");
    }
}
