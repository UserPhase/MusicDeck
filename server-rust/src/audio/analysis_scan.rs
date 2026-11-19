use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use sqlx::{QueryBuilder, Row, Sqlite};

use super::loudness::{
    LibraryScanStatus, LoudnessService, ScanParametersConflict, loudness_storage_error,
};
use super::silence::{SilenceAnalysisService, SilenceParameters, silence_storage_error};
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::db::{DbPool, begin_sqlite_write};
use crate::error::ServerError;
use crate::providers::BackendRegistry;

const PLAYLIST_TRACKS: &str = "
    SELECT DISTINCT COALESCE(i.library_track_id, s.library_item_id) AS track_id
    FROM playlist_items i
    JOIN playlists p ON p.id = i.playlist_id
    LEFT JOIN library_item_sources s
      ON s.connection_id = i.connection_id AND s.provider_item_id = i.provider_track_id
      AND s.item_type = 'track' AND i.library_track_id IS NULL
    WHERE p.owner_user_id = ? AND p.deleted_at IS NULL
      AND COALESCE(i.library_track_id, s.library_item_id) IS NOT NULL";

/// Persistent analysis worker shared by the silence and loudness scans.
#[derive(Clone, Debug)]
pub(crate) struct AnalysisScanService {
    db: DbPool,
    registry: BackendRegistry,
    analyzer: Analyzer,
    workers: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Debug)]
enum Analyzer {
    Silence(SilenceAnalysisService),
    Loudness(LoudnessService),
}

impl AnalysisScanService {
    pub(crate) fn new_silence(db: DbPool, registry: BackendRegistry) -> Self {
        let analyzer = Analyzer::Silence(SilenceAnalysisService::new(Some(db.clone())));
        Self {
            db,
            registry,
            analyzer,
            workers: Arc::default(),
        }
    }

    pub(crate) fn new_loudness(db: DbPool, registry: BackendRegistry) -> Self {
        let analyzer = Analyzer::Loudness(LoudnessService::new(Some(db.clone())));
        Self {
            db,
            registry,
            analyzer,
            workers: Arc::default(),
        }
    }

    pub(crate) fn silence(&self) -> Option<&SilenceAnalysisService> {
        match &self.analyzer {
            Analyzer::Silence(analysis) => Some(analysis),
            Analyzer::Loudness(_) => None,
        }
    }

    fn tables(&self) -> (&'static str, &'static str, &'static str) {
        match self.analyzer {
            Analyzer::Silence(_) => (
                "silence_scan_jobs",
                "silence_scan_tracks",
                "UPDATE silence_scan_jobs SET status = status WHERE 0",
            ),
            Analyzer::Loudness(_) => (
                "loudness_scan_jobs",
                "loudness_scan_tracks",
                "UPDATE loudness_scan_jobs SET status = status WHERE 0",
            ),
        }
    }

    fn storage_error(&self, error: impl std::fmt::Display) -> ServerError {
        match self.analyzer {
            Analyzer::Silence(_) => silence_storage_error(error),
            Analyzer::Loudness(_) => loudness_storage_error(error),
        }
    }

    pub(crate) fn resolver(&self) -> SourceResolver {
        SourceResolver::new(
            self.registry.clone(),
            LibraryService::new(self.db.clone(), None),
        )
    }

    pub(crate) async fn status(
        &self,
        user_id: &str,
        admin: bool,
    ) -> Result<Option<LibraryScanStatus>, ServerError> {
        let (jobs, _, _) = self.tables();
        let row = sqlx::query(&format!(
            "SELECT * FROM {jobs} WHERE ? OR (user_id = ? AND scope = 'playlists')
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ))
        .bind(admin)
        .bind(user_id)
        .fetch_optional(self.db.inner())
        .await
        .map_err(|error| self.storage_error(error))?;
        row.as_ref().map(|row| self.scan_status(row)).transpose()
    }

    pub(crate) async fn start(
        &self,
        user_id: &str,
        admin: bool,
        params: Option<SilenceParameters>,
    ) -> Result<LibraryScanStatus, ServerError> {
        let (jobs, _, lock) = self.tables();
        let scope = if admin { "library" } else { "playlists" };
        let options = params
            .map_or_else(|| Ok("{}".into()), |params| serde_json::to_string(&params))
            .map_err(|error| self.storage_error(error))?;
        let mut tx = begin_sqlite_write(self.db.inner(), lock)
            .await
            .map_err(|error| self.storage_error(error))?;
        let row = if let Some(active) = sqlx::query(&format!(
            "SELECT * FROM {jobs} WHERE status IN ('discovering', 'running') LIMIT 1"
        ))
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| self.storage_error(error))?
        {
            let active_options: String = active
                .try_get("options_json")
                .map_err(|error| self.storage_error(error))?;
            if active
                .try_get::<String, _>("scope")
                .map_err(|error| self.storage_error(error))?
                != scope
                || (!admin
                    && active
                        .try_get::<String, _>("user_id")
                        .map_err(|error| self.storage_error(error))?
                        != user_id)
                || serde_json::from_str::<serde_json::Value>(&active_options).ok()
                    != serde_json::from_str::<serde_json::Value>(&options).ok()
            {
                return Err(ServerError::Conflict(ScanParametersConflict.to_string()));
            }
            active
        } else {
            let id = format!("analysis_{}", nanoid::nanoid!(16));
            let now = Utc::now().to_rfc3339();
            sqlx::query(&format!(
                "INSERT INTO {jobs} (id, user_id, scope, status, options_json, created_at, updated_at)
                 VALUES (?, ?, ?, 'discovering', ?, ?, ?) RETURNING *",
            ))
            .bind(id)
            .bind(user_id)
            .bind(scope)
            .bind(options)
            .bind(&now)
            .bind(&now)
            .fetch_one(&mut *tx).await.map_err(|error| self.storage_error(error))?
        };
        let status = self.scan_status(&row)?;
        tx.commit()
            .await
            .map_err(|error| self.storage_error(error))?;
        self.launch(status.id.clone());
        Ok(status)
    }

    pub(crate) async fn resume(&self) -> Result<(), ServerError> {
        let (jobs, _, _) = self.tables();
        if let Some(row) = sqlx::query(&format!(
            "SELECT * FROM {jobs} WHERE status IN ('discovering', 'running') LIMIT 1"
        ))
        .fetch_optional(self.db.inner())
        .await
        .map_err(|error| self.storage_error(error))?
        {
            self.launch(
                row.try_get("id")
                    .map_err(|error| self.storage_error(error))?,
            );
        }
        Ok(())
    }

    fn launch(&self, id: String) {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !workers.insert(id.clone()) {
            return;
        }
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.run(&id).await {
                tracing::warn!(scan_id = %id, %error, "Audio analysis scan worker stopped");
                if let Err(storage_error) = service
                    .finish(&id, "failed", Some(&error.to_string()))
                    .await
                {
                    tracing::error!(scan_id = %id, %storage_error, "Could not save audio analysis scan failure");
                }
            }
            service
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
        });
    }

    async fn discover(&self, id: &str, owner: &str, library_scan: bool) -> Result<(), ServerError> {
        let (jobs, queue, _) = self.tables();
        let owned = sqlx::query_scalar::<_, String>(PLAYLIST_TRACKS)
            .bind(owner)
            .fetch_all(self.db.inner())
            .await
            .map_err(|error| self.storage_error(error))?;
        let owned: HashSet<_> = owned.into_iter().collect();
        let (tracks, warning) = if library_scan {
            let recent = sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT track_id FROM recently_played WHERE user_id = ?",
            )
            .bind(owner)
            .fetch_all(self.db.inner())
            .await
            .map_err(|error| self.storage_error(error))?;
            let recent: HashSet<_> = recent.into_iter().collect();
            let catalog = CatalogService::new(
                self.registry.clone(),
                LibraryService::new(self.db.clone(), None),
            );
            let result = tokio::time::timeout(Duration::from_secs(180), catalog.list_tracks())
                .await
                .map_err(|_| {
                    ServerError::ServiceUnavailable("Timed out discovering library tracks".into())
                })?;
            if result.degraded && result.items.is_empty() {
                return Err(ServerError::ServiceUnavailable(
                    "Could not load tracks from the library providers".into(),
                ));
            }
            let tracks = result
                .items
                .into_iter()
                .map(|track| {
                    let track = track.item;
                    let priority = if recent.contains(&track.id) {
                        0
                    } else if owned.contains(&track.id) {
                        1
                    } else {
                        2
                    };
                    (track.id, track.title, priority)
                })
                .collect::<Vec<_>>();
            (
                tracks,
                result
                    .degraded
                    .then_some("Some library providers could not be scanned."),
            )
        } else {
            (
                owned
                    .into_iter()
                    .map(|id| (id, String::from("Playlist track"), 1))
                    .collect(),
                None,
            )
        };
        for chunk in tracks.chunks(100) {
            let mut query = QueryBuilder::<Sqlite>::new(format!(
                "INSERT OR IGNORE INTO {queue} (job_id, track_id, title, priority) "
            ));
            query.push_values(chunk, |mut row, (track, title, priority)| {
                row.push_bind(id)
                    .push_bind(track)
                    .push_bind(title)
                    .push_bind(priority);
            });
            query
                .build()
                .execute(self.db.inner())
                .await
                .map_err(|error| self.storage_error(error))?;
        }
        sqlx::query(&format!(
            "UPDATE {jobs} SET status = 'running', warning = ?, updated_at = ?,
             total_tracks = (SELECT COUNT(*) FROM {queue} WHERE job_id = ?)
             WHERE id = ?",
        ))
        .bind(warning)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .bind(id)
        .execute(self.db.inner())
        .await
        .map_err(|error| self.storage_error(error))?;
        Ok(())
    }

    async fn run(&self, id: &str) -> Result<(), ServerError> {
        let (jobs, queue, lock) = self.tables();
        let Some((status, owner, scope, options, mut warning)) =
            sqlx::query_as::<_, (String, String, String, String, Option<String>)>(&format!(
                "SELECT status, user_id, scope, options_json, warning FROM {jobs}
             WHERE id = ? AND status IN ('discovering', 'running')",
            ))
            .bind(id)
            .fetch_optional(self.db.inner())
            .await
            .map_err(|error| self.storage_error(error))?
        else {
            return Ok(());
        };
        let params = if self.silence().is_some() {
            Some(
                serde_json::from_str::<SilenceParameters>(&options)
                    .map_err(|error| self.storage_error(error))?,
            )
        } else {
            None
        };
        let library_scan = scope == "library";
        tracing::info!(scan_id = %id, %scope, "Audio analysis scan started");
        if status == "discovering" {
            self.discover(id, &owner, library_scan).await?;
            warning = sqlx::query_scalar::<_, Option<String>>(&format!(
                "SELECT warning FROM {jobs} WHERE id = ?"
            ))
            .bind(id)
            .fetch_one(self.db.inner())
            .await
            .map_err(|error| self.storage_error(error))?;
        }
        let resolver = self.resolver();
        while let Some((track_id, title)) = sqlx::query_as::<_, (String, String)>(&format!(
            "SELECT track_id, title FROM {queue} WHERE job_id = ? AND status = 'pending'
             ORDER BY priority, track_id LIMIT 1",
        ))
        .bind(id)
        .fetch_optional(self.db.inner())
        .await
        .map_err(|error| self.storage_error(error))?
        {
            sqlx::query(&format!("UPDATE {jobs} SET current_track = ? WHERE id = ?"))
                .bind(title)
                .bind(id)
                .execute(self.db.inner())
                .await
                .map_err(|error| self.storage_error(error))?;
            let result = match (&self.analyzer, params) {
                (Analyzer::Silence(analysis), Some(params)) => analysis
                    .analyze_track(
                        &resolver,
                        &track_id,
                        params,
                        false,
                        Duration::from_secs(110),
                    )
                    .await
                    .map(|(row, cached)| (row.status == "completed", cached, row.error_message)),
                (Analyzer::Loudness(analysis), _) => analysis
                    .scan_track(&resolver, &track_id)
                    .await
                    .map(|cached| (true, cached, None)),
                _ => return Err(self.storage_error("Silence scan settings missing")),
            };
            let (completed, cached, error) = match result {
                Ok(outcome) => outcome,
                Err(error @ ServerError::ServiceUnavailable(_)) => return Err(error),
                Err(error) => (false, false, Some(error.to_string())),
            };
            let mut tx = begin_sqlite_write(self.db.inner(), lock)
                .await
                .map_err(|error| self.storage_error(error))?;
            let status = if completed { "completed" } else { "failed" };
            let changed = sqlx::query(&format!("UPDATE {queue} SET status = ? WHERE job_id = ? AND track_id = ? AND status = 'pending'"))
                .bind(status).bind(id).bind(&track_id).execute(&mut *tx).await.map_err(|error| self.storage_error(error))?;
            if changed.rows_affected() == 0 {
                continue;
            }
            if let Some(error) = error {
                tracing::warn!(scan_id = %id, %track_id, %error, "Could not analyze track in audio analysis scan");
                warning.get_or_insert(error);
            }
            sqlx::query(&format!(
                "UPDATE {jobs} SET completed_tracks = completed_tracks + ?,
                 skipped_tracks = skipped_tracks + ?, failed_tracks = failed_tracks + ?,
                 warning = ?, updated_at = ? WHERE id = ?",
            ))
            .bind(completed)
            .bind(cached)
            .bind(!completed)
            .bind(&warning)
            .bind(Utc::now().to_rfc3339())
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|error| self.storage_error(error))?;
            tx.commit()
                .await
                .map_err(|error| self.storage_error(error))?;
        }
        let (total, completed): (i64, i64) = sqlx::query_as(&format!(
            "SELECT total_tracks, completed_tracks FROM {jobs} WHERE id = ?"
        ))
        .bind(id)
        .fetch_one(self.db.inner())
        .await
        .map_err(|error| self.storage_error(error))?;
        let status = if total > 0 && completed == 0 {
            "failed"
        } else {
            "completed"
        };
        if total == 0 {
            warning.get_or_insert_with(|| "No library tracks were found in this scan.".into());
        }
        self.finish(id, status, warning.as_deref()).await?;
        tracing::info!(scan_id = %id, %status, total, completed, "Audio analysis scan finished");
        Ok(())
    }

    async fn finish(
        &self,
        id: &str,
        status: &str,
        warning: Option<&str>,
    ) -> Result<(), ServerError> {
        let (jobs, _, lock) = self.tables();
        let mut tx = begin_sqlite_write(self.db.inner(), lock)
            .await
            .map_err(|error| self.storage_error(error))?;
        sqlx::query(&format!(
            "UPDATE {jobs} SET status = ?, warning = ?, current_track = NULL, updated_at = ?
             WHERE id = ? AND status IN ('discovering', 'running')",
        ))
        .bind(status)
        .bind(warning)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|error| self.storage_error(error))?;
        tx.commit().await.map_err(|error| self.storage_error(error))
    }

    fn scan_status(&self, row: &sqlx::sqlite::SqliteRow) -> Result<LibraryScanStatus, ServerError> {
        let options: String = row
            .try_get("options_json")
            .map_err(|error| self.storage_error(error))?;
        let status = LibraryScanStatus {
            id: row
                .try_get("id")
                .map_err(|error| self.storage_error(error))?,
            status: row
                .try_get("status")
                .map_err(|error| self.storage_error(error))?,
            total_tracks: row
                .try_get("total_tracks")
                .map_err(|error| self.storage_error(error))?,
            completed_tracks: row
                .try_get("completed_tracks")
                .map_err(|error| self.storage_error(error))?,
            skipped_tracks: row
                .try_get("skipped_tracks")
                .map_err(|error| self.storage_error(error))?,
            failed_tracks: row
                .try_get("failed_tracks")
                .map_err(|error| self.storage_error(error))?,
            current_track: row
                .try_get("current_track")
                .map_err(|error| self.storage_error(error))?,
            warning: row
                .try_get("warning")
                .map_err(|error| self.storage_error(error))?,
            parameters: serde_json::from_str(&options)
                .map_err(|error| self.storage_error(error))?,
        };
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{LibraryItemType, SourceRef};
    use crate::db::run_migrations;
    use crate::providers::media_fixture;
    use crate::tasks::{ProcessError, ProcessExecutionResult, ProcessOptions, ProcessRunner};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Decoder {
        runs: AtomicUsize,
        missing: AtomicBool,
    }

    #[async_trait::async_trait]
    impl ProcessRunner for Decoder {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            _options: ProcessOptions,
        ) -> Result<ProcessExecutionResult, ProcessError> {
            assert_eq!(command, "ffmpeg-fixture");
            if args == ["-hide_banner", "-filters"] {
                if self.missing.load(Ordering::SeqCst) {
                    return Err(ProcessError::SpawnFailed {
                        command: command.into(),
                        reason: "Test decoder missing".into(),
                    });
                }
                return Ok(ProcessExecutionResult {
                    exit_code: Some(0),
                    stdout: " ... silencedetect A->A Detect silence.".into(),
                    stderr: String::new(),
                    signal: None,
                });
            }
            let input = args.iter().position(|arg| arg == "-i").unwrap() + 1;
            assert_eq!(std::fs::read(&args[input]).unwrap(), b"original audio");
            assert!(
                args.iter()
                    .any(|arg| arg == "silencedetect=noise=-28dB:d=0.8")
            );
            self.runs.fetch_add(1, Ordering::SeqCst);
            if self.missing.load(Ordering::SeqCst) {
                return Err(ProcessError::SpawnFailed {
                    command: command.into(),
                    reason: "Test decoder missing".into(),
                });
            }
            Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: String::new(),
                stderr: "Duration: 00:00:10.00\nsilence_start: 0\nsilence_end: 2\nsilence_start: 8\nsilence_end: 10".into(),
                signal: None,
            })
        }
    }

    #[tokio::test]
    async fn silence_scan_stages_audio_and_saves_revision_scoped_profiles_for_owned_playlists() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO roles (name, description) VALUES ('user', 'Listener');
             INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
             VALUES ('listener', 'listener', '', 'Listener', 'user', '', ''),
                    ('other', 'other', '', 'Other', 'user', '', '');
             INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at)
             VALUES ('mine', 'listener', 'Mine', '', ''), ('theirs', 'other', 'Theirs', '', '');",
        ).execute(db.inner()).await.unwrap();

        let library = LibraryService::new(db.clone(), None);
        let track = library
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: "fixture".into(),
                    provider_item_id: "audio-1".into(),
                },
                None,
            )
            .await
            .unwrap();
        let second = library
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: "fixture".into(),
                    provider_item_id: "audio-2".into(),
                },
                None,
            )
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
             VALUES ('1', 'mine', 0, 'fixture', 'audio-1', ?, ''),
                    ('2', 'theirs', 0, 'fixture', 'audio-2', ?, '')",
        ).bind(&track).bind(&second).execute(db.inner()).await.unwrap();

        let registry = BackendRegistry::new(vec![media_fixture::provider(
            "fixture",
            |id, range, if_range, quality| {
                assert_eq!(id, "audio-1");
                assert!(range.is_none() && if_range.is_none() && quality.is_none());
                (
                    Duration::ZERO,
                    media_fixture::response(http::StatusCode::OK, [], "original audio"),
                )
            },
        )]);
        let decoder = Arc::new(Decoder::default());
        let mut scan = AnalysisScanService::new_silence(db.clone(), registry);
        scan.analyzer = Analyzer::Silence(SilenceAnalysisService::with_runner(
            Some(db.clone()),
            decoder.clone(),
            "ffmpeg-fixture",
        ));
        let params = SilenceParameters::validate(Some(-28.0), Some(0.8)).unwrap();
        decoder.missing.store(true, Ordering::SeqCst);
        let rejected = scan.start("listener", false, Some(params)).await.unwrap();
        let failed = wait_for_scan(&scan).await;
        assert_eq!(failed.id, rejected.id);
        assert_eq!(failed.status, "failed");
        assert!(failed.warning.unwrap().contains("FFMPEG_PATH"));
        assert_eq!(decoder.runs.load(Ordering::SeqCst), 0);

        decoder.missing.store(false, Ordering::SeqCst);
        let started = scan.start("listener", false, Some(params)).await.unwrap();
        assert_eq!(started.status, "discovering");
        let completed = wait_for_scan(&scan).await;
        assert_eq!(completed.id, started.id);
        assert_eq!(completed.status, "completed");
        assert_eq!(
            (
                completed.total_tracks,
                completed.completed_tracks,
                completed.failed_tracks
            ),
            (1, 1, 0)
        );
        assert!(scan.status("other", false).await.unwrap().is_none());
        assert_eq!(decoder.runs.load(Ordering::SeqCst), 1);

        let analysis = scan
            .silence()
            .unwrap()
            .get_analysis(&track, Some(params))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(analysis.leading_silence_seconds, Some(2.0));
        assert_eq!(analysis.trailing_silence_seconds, Some(2.0));
        assert!(
            scan.silence()
                .unwrap()
                .get_analysis(&second, None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            scan.silence()
                .unwrap()
                .get_analysis(&track, Some(SilenceParameters::default()))
                .await
                .unwrap()
                .is_none()
        );

        let (saved, reused) = scan
            .silence()
            .unwrap()
            .analyze_track(&scan.resolver(), &track, params, false, Duration::ZERO)
            .await
            .unwrap();
        assert!(reused);
        assert_eq!(saved, analysis);
        scan.start("listener", false, Some(params)).await.unwrap();
        assert_eq!(wait_for_scan(&scan).await.skipped_tracks, 1);
        assert_eq!(decoder.runs.load(Ordering::SeqCst), 1);

        scan.silence()
            .unwrap()
            .analyze_track(
                &scan.resolver(),
                &track,
                params,
                true,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(decoder.runs.load(Ordering::SeqCst), 2);
        decoder.missing.store(true, Ordering::SeqCst);
        let error = scan
            .silence()
            .unwrap()
            .analyze_track(
                &scan.resolver(),
                &track,
                params,
                true,
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("FFMPEG_PATH"));
        // A failed forced analysis must leave the last valid trim profile available.
        assert!(
            scan.silence()
                .unwrap()
                .get_analysis(&track, Some(params))
                .await
                .unwrap()
                .is_some()
        );

        sqlx::query("UPDATE library_items SET content_revision = 'new-audio' WHERE id = ?")
            .bind(&track)
            .execute(db.inner())
            .await
            .unwrap();
        assert!(
            scan.silence()
                .unwrap()
                .get_analysis(&track, Some(params))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            scan.silence()
                .unwrap()
                .get_analysis(&track, None)
                .await
                .unwrap()
                .is_none()
        );
        let failing = scan.start("listener", false, Some(params)).await.unwrap();
        let failed = wait_for_scan(&scan).await;
        assert_eq!(failed.id, failing.id);
        assert_eq!(failed.status, "failed");
        assert!(failed.warning.unwrap().contains("FFMPEG_PATH"));
        assert!(failed.current_track.is_none());

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO silence_scan_jobs (id, user_id, scope, status, options_json, created_at, updated_at)
             VALUES ('interrupted', 'listener', 'playlists', 'discovering', ?, ?, ?)",
        ).bind(serde_json::to_string(&params).unwrap()).bind(&now).bind(&now)
            .execute(db.inner()).await.unwrap();
        decoder.missing.store(false, Ordering::SeqCst);
        scan.resume().await.unwrap();
        let resumed = wait_for_scan(&scan).await;
        assert_eq!(resumed.id, "interrupted");
        assert_eq!(resumed.status, "completed");
        assert_eq!(resumed.completed_tracks, 1);
        assert_eq!(decoder.runs.load(Ordering::SeqCst), 5);
    }

    async fn wait_for_scan(scan: &AnalysisScanService) -> LibraryScanStatus {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(result) = scan.status("listener", false).await.unwrap() {
                    if result.status == "completed" || result.status == "failed" {
                        return result;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("silence worker reaches terminal state")
    }
}
