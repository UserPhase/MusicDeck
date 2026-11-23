use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::tasks::TaskError;

const MAX_MINUTES: u16 = 120;
pub(super) const POST_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub(super) const PLAYLIST_CREATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const AUTO_MAXIMUM: Duration = Duration::from_secs(6 * 60 * 60);
const STALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const ESTIMATE_BUFFER: Duration = Duration::from_secs(5 * 60);
const DEFAULT_MILLIS_PER_TRACK: u64 = 30_000;

/// Maximum download time selection for a Spotify playlist import.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum PlaylistImportTimeout {
    #[default]
    Auto,
    Manual {
        minutes: u16,
    },
}

impl PlaylistImportTimeout {
    pub(super) fn validate(self) -> Result<(), String> {
        if let Self::Manual { minutes } = self {
            if !(1..=MAX_MINUTES).contains(&minutes) {
                return Err(format!(
                    "Maximum import time must be between 1 and {MAX_MINUTES} minutes"
                ));
            }
        }
        Ok(())
    }

    pub(super) fn maximum_ms(self) -> Option<u64> {
        match self {
            Self::Auto => None,
            Self::Manual { minutes } => Some(u64::from(minutes.clamp(1, MAX_MINUTES)) * 60_000),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PlaylistProgress {
    TrackCount(u32),
    TrackFinished,
}

impl PlaylistProgress {
    pub(super) fn from_log(line: &str) -> Option<Self> {
        // spotDL's debug logger prefixes messages with the thread name and can append the source location.
        let message = line
            .split_once(" - ")
            .filter(|(prefix, _)| {
                prefix.contains("MainThread") || prefix.contains("ThreadPoolExecutor")
            })
            .map_or(line, |(_, message)| message)
            .trim_start();
        if let Some(tail) = message.strip_prefix("Downloading ") {
            let mut parts = tail.split_whitespace();
            let count = parts.next()?.parse::<u32>().ok()?;
            if count > 0 && matches!(parts.next(), Some("song" | "songs")) {
                return Some(Self::TrackCount(count));
            }
        }
        if message.starts_with("Downloaded ")
            || (message.starts_with("Skipping ") && message.contains("(file already exists)"))
            || message.split_once(": Error").is_some_and(|(_, tail)| {
                let tail = tail.trim_start();
                tail.is_empty() || tail.starts_with("progress_handler.py:")
            })
        {
            return Some(Self::TrackFinished);
        }
        None
    }
}

pub(super) struct PlaylistDeadline {
    hard_deadline: Instant,
    auto: bool,
    history_ms_per_track: u64,
    last_progress: Instant,
    download_started: Option<Instant>,
    total_tracks: u32,
    finished_tracks: u32,
}

impl PlaylistDeadline {
    pub(super) fn new(
        mode: PlaylistImportTimeout,
        historical_rate: Option<u64>,
        now: Instant,
    ) -> Self {
        Self {
            hard_deadline: now
                + mode
                    .maximum_ms()
                    .map_or(AUTO_MAXIMUM, Duration::from_millis),
            auto: mode == PlaylistImportTimeout::Auto,
            history_ms_per_track: historical_rate
                .unwrap_or(DEFAULT_MILLIS_PER_TRACK)
                .clamp(500, 120_000),
            last_progress: now,
            download_started: None,
            total_tracks: 0,
            finished_tracks: 0,
        }
    }

    pub(super) fn observe(&mut self, progress: PlaylistProgress, now: Instant) {
        match progress {
            PlaylistProgress::TrackCount(count) if self.download_started.is_none() => {
                self.download_started = Some(now);
                self.total_tracks = count;
            }
            PlaylistProgress::TrackFinished => {
                self.finished_tracks = self.finished_tracks.saturating_add(1);
            }
            PlaylistProgress::TrackCount(_) => return,
        }
        self.last_progress = now;
    }

    fn estimate(&self) -> Option<Instant> {
        let started = self.download_started.filter(|_| self.auto)?;
        let mut rate = self.history_ms_per_track;
        if self.finished_tracks >= 5 {
            let elapsed_ms = self.last_progress.duration_since(started).as_millis() as u64;
            let observed_rate = (elapsed_ms / u64::from(self.finished_tracks)).clamp(500, 120_000);
            rate = (rate + 3 * observed_rate) / 4;
        }
        let remaining = u64::from(self.total_tracks.saturating_sub(self.finished_tracks));
        let allowance = Duration::from_millis(2 * rate * remaining) + ESTIMATE_BUFFER;
        Some(self.last_progress + allowance.min(STALL_TIMEOUT))
    }

    pub(super) fn next(&self) -> (Instant, &'static str) {
        let mut next = (
            self.last_progress + STALL_TIMEOUT,
            "Spotify playlist import stopped after 15 minutes without download progress",
        );
        if let Some(estimate) = self.estimate().filter(|&deadline| deadline < next.0) {
            next = (
                estimate,
                "Spotify playlist import stopped without progress within its estimated download time",
            );
        }
        if self.hard_deadline <= next.0 {
            (
                self.hard_deadline,
                "Spotify playlist import reached its maximum download time",
            )
        } else {
            next
        }
    }

    pub(super) fn activity(&mut self, now: Instant) {
        self.last_progress = now;
    }

    pub(super) fn hard_deadline(&self) -> Instant {
        self.hard_deadline
    }
}

pub(super) async fn within_phase<T>(
    context: &crate::tasks::TaskRunContext,
    until: Instant,
    phase: &str,
    work: impl std::future::Future<Output = Result<T, TaskError>>,
) -> Result<T, TaskError> {
    let cancel = context.cancel_token();
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(TaskError::Cancelled),
        result = tokio::time::timeout_at(until, work) => result.map_err(|_| TaskError::ExecutionFailed(format!("The {phase} phase reached its time limit")))?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_spotdl_playlist_counts_and_completed_work() {
        assert_eq!(
            PlaylistProgress::from_log(
                "[09:32:00] DEBUG MainThread - Downloading 500 songs downloader.py:286"
            ),
            Some(PlaylistProgress::TrackCount(500))
        );
        assert_eq!(
            PlaylistProgress::from_log(
                "[09:32:02] INFO ThreadPoolExecutor-0_1 - Downloaded \"Artist - Song\": https://example.test"
            ),
            Some(PlaylistProgress::TrackFinished)
        );
        assert_eq!(
            PlaylistProgress::from_log(
                "[09:32:02] INFO ThreadPoolExecutor-0_1 - Artist - Song: Error    progress_handler.py:395"
            ),
            Some(PlaylistProgress::TrackFinished)
        );
        assert_eq!(PlaylistProgress::from_log("Downloading 32% 2.5MiB/s"), None);
    }

    #[test]
    fn auto_reestimates_with_history_and_live_progress() {
        let start = Instant::now();
        let mut auto = PlaylistDeadline::new(PlaylistImportTimeout::Auto, Some(20_000), start);
        let mut faster_history =
            PlaylistDeadline::new(PlaylistImportTimeout::Auto, Some(4_000), start);
        auto.observe(PlaylistProgress::TrackCount(10), start);
        faster_history.observe(PlaylistProgress::TrackCount(10), start);
        assert_eq!(auto.estimate(), Some(start + Duration::from_secs(700)));
        assert_eq!(
            faster_history.estimate(),
            Some(start + Duration::from_secs(380))
        );
        for track in 1..=5 {
            auto.observe(
                PlaylistProgress::TrackFinished,
                start + Duration::from_secs(track * 4),
            );
        }
        assert_eq!(auto.estimate(), Some(start + Duration::from_secs(400)));
    }

    #[test]
    fn auto_keeps_a_large_active_import_running_past_two_hours() {
        let start = Instant::now();
        let mut auto = PlaylistDeadline::new(PlaylistImportTimeout::Auto, None, start);
        assert_eq!(auto.next().0, start + STALL_TIMEOUT);
        auto.observe(PlaylistProgress::TrackCount(1_200), start);
        for track in 1..=1_000 {
            let now = start + Duration::from_secs(track * 8);
            assert!(now < auto.next().0);
            auto.observe(PlaylistProgress::TrackFinished, now);
        }
        let last_progress = start + Duration::from_secs(8_000);
        let (deadline, message) = auto.next();
        assert_eq!(deadline, last_progress + STALL_TIMEOUT);
        assert!(message.contains("without download progress"));
    }

    #[test]
    fn manual_keeps_the_selected_hard_limit() {
        let start = Instant::now();
        let mode = PlaylistImportTimeout::Manual { minutes: 5 };
        let mut manual = PlaylistDeadline::new(mode, None, start);
        manual.observe(PlaylistProgress::TrackCount(500), start);
        assert_eq!(manual.next().0, start + Duration::from_secs(5 * 60));
        assert!(manual.estimate().is_none());
        assert!(
            PlaylistImportTimeout::Manual { minutes: 0 }
                .validate()
                .is_err()
        );
        assert!(
            PlaylistImportTimeout::Manual { minutes: 121 }
                .validate()
                .is_err()
        );
    }

    #[test]
    fn auto_has_a_hard_limit_even_with_recent_progress() {
        let start = Instant::now();
        let mut deadline = PlaylistDeadline::new(PlaylistImportTimeout::Auto, None, start);
        deadline.observe(PlaylistProgress::TrackCount(1200), start);
        deadline.observe(
            PlaylistProgress::TrackFinished,
            start + AUTO_MAXIMUM - Duration::from_secs(1),
        );
        assert_eq!(deadline.next().0, start + AUTO_MAXIMUM);
        assert!(deadline.next().1.contains("maximum download time"));
    }
}
