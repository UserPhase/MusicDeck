//! Bounded playback derivatives. Original audio is streamed into private staging files.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use sqlx::FromRow;
use tokio::io::AsyncWriteExt;
use tokio::sync::{OnceCell, Semaphore, watch};
use tokio_util::sync::CancellationToken;

use super::ffmpeg::AUDIO_INPUT_FORMATS;
use super::loudness::{
    LOUDNESS_CACHE_TTL_MS, LoudnessMeasurement, LoudnessService, MAX_LOUDNESS_INPUT_BYTES,
    TRUE_PEAK_LIMIT, loudness_stream_cache_key, parse_loudness, read_measurement,
    store_measurement,
};
use crate::catalog::LibraryService;
use crate::db::{DbError, DbPool, begin_sqlite_write};
use crate::streaming::http::MediaBody;
use crate::tasks::ProcessOptions;

const MAX_JOBS: usize = 6;
const MAX_ACTIVE: usize = 2;
const MAX_OUTPUT_BYTES: u64 = 192 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(180);
const QUEUE_TIMEOUT: Duration = Duration::from_secs(10);
const FAILED_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreparedAccess {
    Library,
    External,
    PublicPreview,
}

impl PreparedAccess {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Library => "false",
            Self::External => "true",
            Self::PublicPreview => "preview",
        }
    }

    fn code(self) -> i64 {
        match self {
            Self::Library => 0,
            Self::External => 1,
            Self::PublicPreview => 2,
        }
    }

    fn from_code(value: i64) -> Option<Self> {
        match value {
            0 => Some(Self::Library),
            1 => Some(Self::External),
            2 => Some(Self::PublicPreview),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Preparation {
    pub identity: String,
    pub track_revision: Option<(String, String)>,
    pub access: PreparedAccess,
    pub preview: bool,
    pub bitrate: Option<u32>,
    pub target: i32,
}

impl Preparation {
    pub fn key(&self) -> String {
        loudness_stream_cache_key(&self.identity, self.access.tag(), self.bitrate, self.target)
    }
}

#[derive(Debug, FromRow)]
struct ArtifactRow {
    external: i64,
    format: String,
    integrated_lufs: f64,
    true_peak_db: f64,
    bytes: i64,
    track_id: Option<String>,
    content_revision: Option<String>,
}

#[derive(Debug)]
pub(crate) struct PreparedArtifact {
    pub path: PathBuf,
    pub content_type: &'static str,
    pub access: PreparedAccess,
    pub integrated_lufs: f64,
    pub true_peak_db: f64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum PreparationError {
    #[error("Media preparation database unavailable: {0}")]
    Db(#[from] sqlx::Error),
    #[error("Media preparation database unavailable: {0}")]
    Library(#[from] DbError),
    #[error("Media preparation storage unavailable: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Work(String),
}

#[derive(Debug)]
enum CacheDirectory {
    Persistent(PathBuf),
    Temporary(tempfile::TempDir),
}

impl CacheDirectory {
    fn as_path(&self) -> &Path {
        match self {
            Self::Persistent(path) => path,
            Self::Temporary(dir) => dir.path(),
        }
    }
}

#[derive(Debug, Default)]
struct Jobs {
    running: HashMap<String, watch::Receiver<bool>>,
    failures: HashMap<String, tokio::time::Instant>,
}

#[derive(Debug)]
pub(crate) struct PreparedAudio {
    db: DbPool,
    loudness: LoudnessService,
    directory: OnceCell<CacheDirectory>,
    jobs: Mutex<Jobs>,
    active: Semaphore,
    publication: tokio::sync::Mutex<()>,
}

impl PreparedAudio {
    pub fn new(db: DbPool) -> Self {
        Self {
            loudness: LoudnessService::new(Some(db.clone())),
            db,
            directory: OnceCell::new(),
            jobs: Mutex::default(),
            active: Semaphore::new(MAX_ACTIVE),
            publication: tokio::sync::Mutex::new(()),
        }
    }

    async fn directory(&self) -> Result<&Path, PreparationError> {
        let directory = self
            .directory
            .get_or_try_init(|| async {
                let Some(parent) = self.db.path().and_then(Path::parent) else {
                    return Ok(CacheDirectory::Temporary(tempfile::tempdir()?));
                };
                let path = parent.join("playback-cache");
                tokio::fs::create_dir_all(&path).await?;
                let metadata = tokio::fs::symlink_metadata(&path).await?;
                if !metadata.is_dir() || metadata.is_symlink() {
                    return Err(PreparationError::Work(
                        "Invalid playback cache directory".into(),
                    ));
                }
                self.remove_abandoned(&path).await?;
                Ok(CacheDirectory::Persistent(path))
            })
            .await?;
        Ok(directory.as_path())
    }

    pub async fn artifact(&self, key: &str) -> Result<Option<PreparedArtifact>, PreparationError> {
        if !valid_key(key) {
            return Ok(None);
        }
        let row = sqlx::query_as::<_, ArtifactRow>(
            "SELECT external, format, integrated_lufs, true_peak_db, bytes, track_id, content_revision
             FROM playback_loudness_cache WHERE cache_key = ? AND expires_at > ?",
        ).bind(key).bind(Utc::now().timestamp_millis()).fetch_optional(self.db.inner()).await?;
        let Some(row) = row else { return Ok(None) };
        let Some(access) = PreparedAccess::from_code(row.external) else {
            return Ok(None);
        };
        if access == PreparedAccess::Library {
            let (Some(track), Some(revision)) = (row.track_id, row.content_revision) else {
                return Ok(None);
            };
            if LibraryService::new(self.db.clone(), None)
                .track_content_revision(&track)
                .await?
                .as_ref()
                != Some(&revision)
            {
                return Ok(None);
            }
        }
        let Some(content_type) = content_type(&row.format) else {
            return Ok(None);
        };
        let path = self
            .directory()
            .await?
            .join(format!("{key}.{}", row.format));
        let metadata = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file()
            || metadata.is_symlink()
            || row.bytes <= 0
            || !row.integrated_lufs.is_finite()
            || !row.true_peak_db.is_finite()
            || metadata.len() != row.bytes as u64
        {
            return Ok(None);
        }
        Ok(Some(PreparedArtifact {
            path,
            content_type,
            access,
            integrated_lufs: row.integrated_lufs,
            true_peak_db: row.true_peak_db,
        }))
    }

    pub fn start<F>(
        self: &Arc<Self>,
        request: Preparation,
        permit: Option<CancellationToken>,
        load: impl FnOnce() -> F + Send + 'static,
    ) -> Option<watch::Receiver<bool>>
    where
        F: Future<Output = Result<MediaBody, PreparationError>> + Send + 'static,
    {
        let key = request.key();
        let mut jobs = self
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = jobs.running.get(&key) {
            return Some(existing.clone());
        }
        let now = tokio::time::Instant::now();
        jobs.failures.retain(|_, until| *until > now);
        if jobs.running.len() >= MAX_JOBS || jobs.failures.contains_key(&key) {
            return None;
        }
        let (done, waiting) = watch::channel(false);
        jobs.running.insert(key.clone(), waiting.clone());
        let worker = Arc::clone(self);
        let admission = Admission {
            worker: worker.clone(),
            key: key.clone(),
            failed: true,
        };
        tokio::spawn(async move {
            let mut admission = admission;
            let result = async {
                let _slot = tokio::time::timeout(QUEUE_TIMEOUT, worker.active.acquire()).await
                    .map_err(|_| PreparationError::Work("Playback preparation queue is busy".into()))?
                    .map_err(|_| PreparationError::Work("Playback preparation is shutting down".into()))?;
                let work = tokio::time::timeout(JOB_TIMEOUT, worker.prepare(&key, request, permit.as_ref(), load));
                tokio::select! {
                    biased;
                    () = cancelled(permit.as_ref()) => Err(PreparationError::Work("External playback was revoked".into())),
                    result = work => result.map_err(|_| PreparationError::Work("Playback preparation timed out".into()))?,
                }
            }.await;
            admission.failed = result.is_err();
            if let Err(error) = result {
                tracing::debug!(%error, "Playback preparation unavailable");
            }
            drop(admission);
            done.send_replace(true);
        });
        Some(waiting)
    }

    pub fn is_processing(&self, key: &str) -> bool {
        self.jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .running
            .contains_key(key)
    }

    async fn prepare<F>(
        &self,
        key: &str,
        request: Preparation,
        permit: Option<&CancellationToken>,
        load: impl FnOnce() -> F,
    ) -> Result<(), PreparationError>
    where
        F: Future<Output = Result<MediaBody, PreparationError>>,
    {
        if self.artifact(key).await?.is_some() {
            return Ok(());
        }
        self.loudness
            .executable()
            .await
            .map_err(PreparationError::Work)?;
        let directory = self.directory().await?;
        let staging = tempfile::Builder::new()
            .prefix(".preparing-")
            .tempdir_in(directory)?;
        let input = staging.path().join("input");
        let format = if request.bitrate.is_some() {
            "mp3"
        } else {
            "flac"
        };
        let output = staging.path().join(format!("output.{format}"));
        let mut source = load().await?;
        let mut file = tokio::fs::File::create(&input).await?;
        let mut bytes = 0_u64;
        while let Some(chunk) = source.next().await {
            let chunk = chunk?;
            bytes = bytes.saturating_add(chunk.len() as u64);
            if bytes > MAX_LOUDNESS_INPUT_BYTES {
                return Err(PreparationError::Work(
                    "Source exceeds preparation limit".into(),
                ));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        if bytes == 0 {
            return Err(PreparationError::Work("Empty audio source".into()));
        }

        let peak = if request.bitrate.is_some() {
            -2.0
        } else {
            TRUE_PEAK_LIMIT
        };
        let filter = format!("loudnorm=I={}:TP={peak}:LRA=20", request.target);
        let tag = request.access.tag();
        let (measurement, offset) = match read_measurement(&self.db, &request.identity, tag).await?
        {
            Some(measurement) => (measurement, "0".to_owned()),
            None => {
                let measurement = self.measure(&input, request.preview, &filter).await?;
                let offset = measurement.target_offset.clone();
                self.check_revision(request.track_revision.as_ref()).await?;
                store_measurement(&self.db, &request.identity, tag, &measurement).await?;
                (measurement, offset)
            }
        };
        let filter = format!(
            "{filter}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={offset}:linear=true",
            measurement.input_i,
            measurement.input_tp,
            measurement.input_lra,
            measurement.input_thresh
        );
        let mut args = input_args(&input, request.preview);
        extend(
            &mut args,
            &[
                "-map",
                "0:a:0",
                "-map_metadata",
                "-1",
                "-af",
                &filter,
                "-ar",
                "48000",
                "-c:a",
            ],
        );
        if let Some(bitrate) = request.bitrate {
            extend(&mut args, &["libmp3lame", "-b:a", &format!("{bitrate}k")]);
        } else {
            extend(&mut args, &["flac", "-sample_fmt", "s32"]);
        }
        extend(
            &mut args,
            &[
                "-threads",
                "1",
                "-fs",
                &MAX_OUTPUT_BYTES.to_string(),
                &output.to_string_lossy(),
            ],
        );
        self.run(&args).await?;
        let size = tokio::fs::metadata(&output).await?.len();
        if size == 0 || size >= MAX_OUTPUT_BYTES {
            return Err(PreparationError::Work(
                "Prepared audio exceeds its output limit".into(),
            ));
        }
        let verification = self
            .measure(
                &output,
                false,
                &format!("loudnorm=I={}:TP={TRUE_PEAK_LIMIT}:LRA=20", request.target),
            )
            .await?;
        let (Some(lufs), Some(peak)) =
            (verification.integrated_lufs(), verification.true_peak_db())
        else {
            return Err(PreparationError::Work(
                "Prepared audio has no valid loudness measurement".into(),
            ));
        };
        if (lufs - f64::from(request.target)).abs() > 1.0 || peak > TRUE_PEAK_LIMIT + 0.1 {
            return Err(PreparationError::Work(
                "Prepared audio did not meet the loudness target".into(),
            ));
        }
        let _publication = self.publication.lock().await;
        self.prune(directory, key, size).await?;
        let mut tx = begin_sqlite_write(
            self.db.inner(),
            "UPDATE playback_loudness_cache SET accessed_at=accessed_at WHERE 0",
        )
        .await?;
        if let Some((track, revision)) = &request.track_revision {
            let current: Option<String> = sqlx::query_scalar(
                "SELECT content_revision FROM library_items WHERE type='track' AND id=?",
            )
            .bind(track)
            .fetch_optional(&mut *tx)
            .await?;
            if current.as_ref() != Some(revision) {
                return Err(PreparationError::Work(
                    "Audio source changed during preparation".into(),
                ));
            }
        }
        if permit.is_some_and(CancellationToken::is_cancelled) {
            return Err(PreparationError::Work(
                "External playback was revoked".into(),
            ));
        }
        let now = Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT OR REPLACE INTO playback_loudness_cache
              (cache_key, external, format, integrated_lufs, true_peak_db, bytes, expires_at, accessed_at, track_id, content_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(key).bind(request.access.code()).bind(format).bind(lufs).bind(peak).bind(size as i64)
            .bind(now + LOUDNESS_CACHE_TTL_MS).bind(now)
            .bind(request.track_revision.as_ref().map(|(track, _)| track))
            .bind(request.track_revision.as_ref().map(|(_, revision)| revision))
            .execute(&mut *tx).await?;
        // A staged file is visible only once the metadata transaction commits.
        let path = directory.join(format!("{key}.{format}"));
        // Use one atomic filesystem operation so dropping a cancelled job
        // cannot leave an in-flight rename after the cleanup guard runs.
        std::fs::rename(output, &path)?;
        let mut unpublished = UnpublishedFile(Some(path));
        tx.commit().await?;
        unpublished.0 = None;
        Ok(())
    }

    async fn check_revision(
        &self,
        expected: Option<&(String, String)>,
    ) -> Result<(), PreparationError> {
        if let Some((track, revision)) = expected
            && LibraryService::new(self.db.clone(), None)
                .track_content_revision(track)
                .await?
                .as_ref()
                != Some(revision)
        {
            return Err(PreparationError::Work(
                "Audio source changed during preparation".into(),
            ));
        }
        Ok(())
    }

    async fn measure(
        &self,
        path: &Path,
        preview: bool,
        filter: &str,
    ) -> Result<LoudnessMeasurement, PreparationError> {
        let mut args = input_args(path, preview);
        extend(
            &mut args,
            &[
                "-map",
                "0:a:0",
                "-af",
                &format!("{filter}:print_format=json"),
                "-f",
                "null",
                "-",
            ],
        );
        parse_loudness(&self.run(&args).await?).map_err(PreparationError::Work)
    }

    async fn run(&self, args: &[String]) -> Result<String, PreparationError> {
        let result = self
            .loudness
            .runner
            .run(
                self.loudness
                    .executable()
                    .await
                    .map_err(PreparationError::Work)?,
                args,
                ProcessOptions {
                    timeout_ms: Some(120_000),
                    ..ProcessOptions::default()
                },
            )
            .await
            .map_err(|_| {
                PreparationError::Work("FFmpeg could not process playback audio".into())
            })?;
        if result.exit_code != Some(0) {
            return Err(PreparationError::Work(
                "FFmpeg rejected playback audio".into(),
            ));
        }
        Ok(result.stderr)
    }

    async fn prune(
        &self,
        directory: &Path,
        key: &str,
        incoming: u64,
    ) -> Result<(), PreparationError> {
        let now = Utc::now().timestamp_millis();
        sqlx::query("DELETE FROM playback_loudness_measurements WHERE expires_at <= ?")
            .bind(now)
            .execute(self.db.inner())
            .await?;
        let rows = sqlx::query_as::<_, (String, String, i64, i64)>(
            "SELECT cache_key, format, bytes, expires_at FROM playback_loudness_cache
             WHERE cache_key != ? ORDER BY accessed_at ASC",
        )
        .bind(key)
        .fetch_all(self.db.inner())
        .await?;
        let mut total = rows.iter().fold(incoming, |sum, (_, _, bytes, _)| {
            sum.saturating_add((*bytes).max(0) as u64)
        });
        for (expired_key, format, size, expires) in rows {
            if (expires <= now || total > MAX_CACHE_BYTES)
                && valid_key(&expired_key)
                && content_type(&format).is_some()
            {
                match tokio::fs::remove_file(directory.join(format!("{expired_key}.{format}")))
                    .await
                {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => continue,
                }
                sqlx::query("DELETE FROM playback_loudness_cache WHERE cache_key = ?")
                    .bind(expired_key)
                    .execute(self.db.inner())
                    .await?;
                total = total.saturating_sub(size.max(0) as u64);
            }
        }
        if total > MAX_CACHE_BYTES {
            return Err(PreparationError::Work("Playback cache is full".into()));
        }
        Ok(())
    }

    async fn remove_abandoned(&self, path: &Path) -> Result<(), PreparationError> {
        let mut entries = tokio::fs::read_dir(path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !entry
                .metadata()
                .await?
                .modified()?
                .elapsed()
                .is_ok_and(|age| age > Duration::from_secs(600))
            {
                continue;
            }
            let kind = entry.file_type().await?;
            if kind.is_dir()
                && name.strip_prefix(".preparing-").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
            {
                let _ = tokio::fs::remove_dir_all(entry.path()).await;
            } else if kind.is_file()
                && let Some((key, format)) = name.split_once('.')
                && valid_key(key)
                && content_type(format).is_some()
            {
                let present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_loudness_cache WHERE cache_key=? AND format=?)")
                    .bind(key).bind(format).fetch_one(self.db.inner()).await?;
                if !present {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        Ok(())
    }
}

struct Admission {
    worker: Arc<PreparedAudio>,
    key: String,
    failed: bool,
}

struct UnpublishedFile(Option<PathBuf>);

impl Drop for UnpublishedFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut jobs = self
            .worker
            .jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        jobs.running.remove(&self.key);
        if self.failed && jobs.failures.len() < 256 {
            jobs.failures
                .insert(self.key.clone(), tokio::time::Instant::now() + FAILED_TTL);
        }
    }
}

async fn cancelled(permit: Option<&CancellationToken>) {
    if let Some(permit) = permit {
        permit.cancelled().await
    } else {
        std::future::pending().await
    }
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn content_type(format: &str) -> Option<&'static str> {
    match format {
        "mp3" => Some("audio/mpeg"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

fn extend(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|value| (*value).to_owned()));
}

fn input_args(path: &Path, preview: bool) -> Vec<String> {
    let mut args = Vec::new();
    extend(
        &mut args,
        &[
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-xerror",
            "-y",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            AUDIO_INPUT_FORMATS,
        ],
    );
    if preview {
        extend(&mut args, &["-t", "30"]);
    }
    extend(&mut args, &["-i", &path.to_string_lossy()]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tasks::{ProcessError, ProcessExecutionResult, ProcessRunner};

    #[derive(Default)]
    struct FakeFfmpeg(AtomicUsize);

    #[async_trait::async_trait]
    impl ProcessRunner for FakeFfmpeg {
        async fn run(
            &self,
            _command: &str,
            args: &[String],
            _: ProcessOptions,
        ) -> Result<ProcessExecutionResult, ProcessError> {
            if args == ["-hide_banner", "-filters"] {
                return Ok(ProcessExecutionResult {
                    exit_code: Some(0),
                    stdout: " ... loudnorm A->A".into(),
                    stderr: String::new(),
                    signal: None,
                });
            }
            self.0.fetch_add(1, Ordering::Relaxed);
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["-protocol_whitelist", "file,pipe"])
            );
            let input = args.windows(2).find(|pair| pair[0] == "-i").unwrap();
            let mut integrated = "-23.00";
            if args.iter().any(|arg| arg == "-c:a") {
                tokio::fs::write(args.last().unwrap(), b"prepared-audio")
                    .await
                    .unwrap();
            } else if input[1].contains("output.") {
                integrated = "-16.00";
            }
            Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: String::new(),
                signal: None,
                stderr: serde_json::json!({
                    "input_i": integrated, "input_tp": "-2", "input_lra": "4",
                    "input_thresh": "-29", "target_offset": "0.0", "output_i": "-16",
                    "output_tp": "-2"
                })
                .to_string(),
            })
        }
    }

    async fn fixture() -> (Arc<PreparedAudio>, Arc<FakeFfmpeg>) {
        let db = DbPool::connect_memory().await.unwrap();
        crate::db::run_migrations(&db, None).await.unwrap();
        let mut worker = PreparedAudio::new(db.clone());
        let runner = Arc::new(FakeFfmpeg::default());
        worker.loudness = LoudnessService::with_runner(Some(db), runner.clone(), "ffmpeg-fixture");
        (Arc::new(worker), runner)
    }

    fn work(identity: &str) -> Preparation {
        Preparation {
            identity: identity.into(),
            track_revision: None,
            access: PreparedAccess::PublicPreview,
            preview: true,
            bitrate: None,
            target: -16,
        }
    }

    fn sample_audio() -> MediaBody {
        Box::pin(futures_util::stream::once(async {
            Ok(bytes::Bytes::from_static(b"sample"))
        }))
    }

    #[tokio::test]
    async fn normalization_deduplicates_and_checks_content_revision_when_serving() {
        let (worker, runner) = fixture().await;
        sqlx::query(
            "INSERT INTO library_items (id, type, created_at, updated_at, content_revision)
            VALUES ('track', 'track', 'now', 'now', 'revision-a')",
        )
        .execute(worker.db.inner())
        .await
        .unwrap();
        let request = || Preparation {
            access: PreparedAccess::Library,
            preview: false,
            track_revision: Some(("track".into(), "revision-a".into())),
            ..work("original")
        };
        let key = request().key();
        let gate = Arc::new(Semaphore::new(0));
        let wait = gate.clone();
        let mut first = worker
            .start(request(), None, move || async move {
                wait.acquire().await.unwrap().forget();
                Ok(sample_audio())
            })
            .unwrap();
        let mut joined = worker
            .start(request(), None, || async { panic!("duplicate load") })
            .unwrap();
        assert!(worker.is_processing(&key));
        assert!(worker.artifact(&key).await.unwrap().is_none());
        gate.add_permits(1);
        let _ = first.wait_for(|ready| *ready).await.unwrap();
        let _ = joined.wait_for(|ready| *ready).await.unwrap();
        let artifact = worker.artifact(&key).await.unwrap().unwrap();
        assert_eq!(runner.0.load(Ordering::Relaxed), 3);
        assert_eq!(artifact.content_type, "audio/flac");
        assert_eq!(
            tokio::fs::read(artifact.path).await.unwrap(),
            b"prepared-audio"
        );
        let mut mp3 = request();
        mp3.bitrate = Some(192);
        let other_key = mp3.key();
        let mut ready = worker
            .start(mp3, None, || async { Ok(sample_audio()) })
            .unwrap();
        let _ = ready.wait_for(|ready| *ready).await.unwrap();
        assert_eq!(
            worker
                .artifact(&other_key)
                .await
                .unwrap()
                .unwrap()
                .content_type,
            "audio/mpeg"
        );
        assert_eq!(
            runner.0.load(Ordering::Relaxed),
            5,
            "the second encoding reuses the first measurement"
        );
        sqlx::query("UPDATE library_items SET content_revision='revision-b' WHERE id='track'")
            .execute(worker.db.inner())
            .await
            .unwrap();
        assert!(worker.artifact(&key).await.unwrap().is_none());
        assert!(worker.artifact(&other_key).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn normalization_limits_queued_and_running_work_and_cancels_on_privacy_change() {
        let (worker, runner) = fixture().await;
        let cancellation = CancellationToken::new();
        let started = Arc::new(Semaphore::new(0));
        let mut jobs = Vec::new();
        for index in 0..MAX_JOBS {
            let started = started.clone();
            jobs.push(
                worker
                    .start(
                        work(&index.to_string()),
                        Some(cancellation.clone()),
                        move || async move {
                            started.add_permits(1);
                            std::future::pending::<Result<MediaBody, PreparationError>>().await
                        },
                    )
                    .unwrap(),
            );
        }
        assert!(
            worker
                .start(work("overflow"), None, || async {
                    panic!("queue should be full")
                })
                .is_none()
        );
        let permits = tokio::time::timeout(
            Duration::from_secs(2),
            started.acquire_many(MAX_ACTIVE as u32),
        )
        .await
        .unwrap()
        .unwrap();
        permits.forget();
        assert_eq!(started.available_permits(), 0);
        cancellation.cancel();
        for mut job in jobs {
            let _ = job.wait_for(|done| *done).await.unwrap();
        }
        assert_eq!(runner.0.load(Ordering::Relaxed), 0);
        assert!(worker.artifact(&work("0").key()).await.unwrap().is_none());
    }
}
