use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use crate::tasks::TaskError;

const MAX_MINUTES: u16 = 120;
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
    hard_deadline: Option<Instant>,
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
            hard_deadline: mode.maximum_ms().map(|ms| now + Duration::from_millis(ms)),
            history_ms_per_track: historical_rate
                .unwrap_or(DEFAULT_MILLIS_PER_TRACK)
                .clamp(500, 120_000),
            last_progress: now,
            download_started: None,
            total_tracks: 0,
            finished_tracks: 0,
        }
    }

    fn observe(&mut self, progress: PlaylistProgress, now: Instant) {
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
        let started = self
            .download_started
            .filter(|_| self.hard_deadline.is_none())?;
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

    fn next(&self) -> (Instant, &'static str) {
        let stalled = self.last_progress + STALL_TIMEOUT;
        if let Some(hard_deadline) = self.hard_deadline.filter(|&deadline| deadline <= stalled) {
            return (
                hard_deadline,
                "Spotify playlist import reached its maximum download time",
            );
        }
        if let Some(estimate) = self.estimate().filter(|&deadline| deadline < stalled) {
            return (
                estimate,
                "Spotify playlist import stopped without progress within its estimated download time",
            );
        }
        (
            stalled,
            "Spotify playlist import stopped after 15 minutes without download progress",
        )
    }

    pub(super) async fn wait(
        mut self,
        updates: &mut mpsc::UnboundedReceiver<PlaylistProgress>,
    ) -> TaskError {
        loop {
            let (deadline, message) = self.next();
            tokio::select! {
                () = sleep_until(deadline) => return TaskError::ExecutionFailed(message.into()),
                Some(progress) = updates.recv() => self.observe(progress, Instant::now()),
            }
        }
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

    #[tokio::test]
    async fn expired_deadline_returns_a_failure() {
        let start = Instant::now() - Duration::from_secs(5 * 60);
        let deadline =
            PlaylistDeadline::new(PlaylistImportTimeout::Manual { minutes: 5 }, None, start);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        assert!(
            matches!(deadline.wait(&mut rx).await, TaskError::ExecutionFailed(message) if message.contains("maximum download time"))
        );
    }
}
