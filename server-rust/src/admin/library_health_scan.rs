//! # Admin Library Health Scanner & Orphan Pruning Service (`admin::library_health_scan`)
//!
//! Ports `server/src/services/library/libraryHealthScanService.ts`:
//! - [`LibraryHealthScanState`] (`idle | running | completed | failed`)
//! - [`LibraryHealthScanPhase`] (`listing | catalog | records | pruning`)
//! - [`LibraryHealthPruneResult`], [`LibraryHealthReportSummary`], [`LibraryHealthReport`],
//!   [`LibraryHealthScanStatus`], and [`LibraryHealthScanBusy`]
//! - [`LibraryHealthScanService`]:
//!   - Runs catalog auditing (`audit_catalog`), orphaned track detection (`find_orphaned_tracks`),
//!     and dangling reference counting (`count_dangling_references`) off the request path
//!   - `start_prune`: Re-lists the library first and prunes only orphaned `library_items`
//!     confirmed absent by the fresh listing while preserving tracks referenced by `playlist_items`

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::catalog::CatalogService;
use crate::db::DbPool;
use crate::profile::{
    LibraryHealthIssue, LibraryHealthIssueType, audit_catalog, count_issues,
};
use crate::providers::BackendRegistry;

/// Maximum issues included in a [`LibraryHealthReport`] (`500`).
pub const HEALTH_REPORT_ISSUE_LIMIT: usize = 500;

/// Lifecycle state of an admin library health scan (`LibraryHealthScanState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryHealthScanState {
    Idle,
    Running,
    Completed,
    Failed,
}

/// Active phase of a running library health scan (`LibraryHealthScanPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryHealthScanPhase {
    Listing,
    Catalog,
    Records,
    Pruning,
}

/// Summary of an orphan-track pruning pass (`LibraryHealthPruneResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthPruneResult {
    pub pruned_tracks: usize,
    pub kept_in_playlists: usize,
    pub removed_favorites: usize,
    pub removed_ratings: usize,
    pub skipped_reason: Option<String>,
}

/// Quantitative summary inside a [`LibraryHealthReport`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthReportSummary {
    pub albums: usize,
    pub tracks: usize,
    pub artists: usize,
    pub track_records: usize,
    pub missing_artwork: usize,
    pub metadata_issues: usize,
    pub duplicates: usize,
    pub unavailable: usize,
    pub incomplete_albums: usize,
    pub sync_mismatches: usize,
    pub orphaned_tracks: usize,
    pub dangling_references: usize,
}

/// Completed library health report (`LibraryHealthReport`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthReport {
    pub completed_at: String,
    pub degraded: bool,
    pub summary: LibraryHealthReportSummary,
    pub issues: Vec<LibraryHealthIssue>,
    pub issue_total: usize,
    pub prune: Option<LibraryHealthPruneResult>,
}

/// Pollable status snapshot returned by `GET /api/admin/library/health/scan`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthScanStatus {
    pub id: Option<String>,
    pub state: LibraryHealthScanState,
    pub phase: Option<LibraryHealthScanPhase>,
    pub processed: usize,
    pub total: usize,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub stale_reason: Option<String>,
    pub report: Option<LibraryHealthReport>,
}

impl Default for LibraryHealthScanStatus {
    fn default() -> Self {
        Self {
            id: None,
            state: LibraryHealthScanState::Idle,
            phase: None,
            processed: 0,
            total: 0,
            started_at: None,
            finished_at: None,
            error: None,
            warnings: Vec::new(),
            stale_reason: None,
            report: None,
        }
    }
}

/// Error returned when a health check or prune pass is requested while another is already running.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("A library health check is already running. Wait for it to finish first.")]
pub struct LibraryHealthScanBusy;

/// Background service executing admin library health scans and orphan track pruning.
#[derive(Clone)]
pub struct LibraryHealthScanService {
    db: Option<DbPool>,
    backends: BackendRegistry,
    status: Arc<RwLock<LibraryHealthScanStatus>>,
    running: Arc<AtomicBool>,
}

impl std::fmt::Debug for LibraryHealthScanService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryHealthScanService")
            .field("running", &self.running.load(Ordering::Relaxed))
            .finish()
    }
}

impl LibraryHealthScanService {
    /// Creates a new [`LibraryHealthScanService`].
    #[must_use]
    pub fn new(db: Option<DbPool>, backends: BackendRegistry) -> Self {
        Self {
            db,
            backends,
            status: Arc::new(RwLock::new(LibraryHealthScanStatus::default())),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns a snapshot of the current [`LibraryHealthScanStatus`].
    #[must_use]
    pub fn status(&self) -> LibraryHealthScanStatus {
        self.status
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Starts a background library health scan, or returns `(false, status)` if one is already running.
    pub fn start(&self) -> (bool, LibraryHealthScanStatus) {
        if self
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return (false, self.status());
        }
        self.launch(false);
        (true, self.status())
    }

    /// Starts a fresh scan + orphan-pruning pass, returning [`LibraryHealthScanBusy`] if a scan is already running.
    pub fn start_prune(&self) -> Result<LibraryHealthScanStatus, LibraryHealthScanBusy> {
        if self
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(LibraryHealthScanBusy);
        }
        self.launch(true);
        Ok(self.status())
    }

    /// Marks the current health report as stale after requesting an upstream artwork rescan.
    pub fn request_artwork_rescan(&self) -> (bool, LibraryHealthScanStatus) {
        if let Ok(mut guard) = self.status.write() {
            if guard.report.is_some() {
                guard.stale_reason = Some(String::from(
                    "A media server rescan was requested. Run the health check again once it finishes.",
                ));
            }
        }
        (true, self.status())
    }

    fn launch(&self, prune: bool) {
        let id = format!("health_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();

        if let Ok(mut guard) = self.status.write() {
            let prev_report = guard.report.clone();
            let prev_stale = guard.stale_reason.clone();
            *guard = LibraryHealthScanStatus {
                id: Some(id.clone()),
                state: LibraryHealthScanState::Running,
                phase: Some(LibraryHealthScanPhase::Listing),
                processed: 0,
                total: 0,
                started_at: Some(now),
                finished_at: None,
                error: None,
                warnings: Vec::new(),
                stale_reason: prev_stale,
                report: prev_report,
            };
        }

        let svc = self.clone();
        tokio::spawn(async move {
            svc.execute_scan(&id, prune).await;
            svc.running.store(false, Ordering::Release);
        });
    }

    async fn execute_scan(&self, run_id: &str, prune: bool) {
        let Some(pool) = &self.db else {
            if let Ok(mut guard) = self.status.write() {
                guard.state = LibraryHealthScanState::Failed;
                guard.phase = None;
                guard.finished_at = Some(Utc::now().to_rfc3339());
                guard.error = Some(String::from("Database is unavailable"));
            }
            return;
        };

        let catalog = CatalogService::from_pool(pool.clone(), self.backends.clone());
        let (tracks_res, albums_res, artists_res) = tokio::join!(
            catalog.list_tracks(),
            catalog.list_albums(Some(10_000)),
            catalog.list_artists()
        );
        let albums_res = albums_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });
        let artists_res = artists_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });

        let degraded = tracks_res.degraded || albums_res.degraded || artists_res.degraded;
        let mut warnings = Vec::new();
        if degraded {
            warnings.push(String::from(
                "Some media servers did not respond. Their records were not checked for orphans.",
            ));
        }

        let track_record_count: usize = sqlx::query(
            "SELECT COUNT(*) AS count FROM library_items WHERE type = 'track'",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<i64, _>("count").ok())
        .unwrap_or(0)
        .max(0) as usize;

        let catalog_work = tracks_res.items.len() * 2 + albums_res.items.len();
        let total_work = catalog_work + track_record_count;

        if let Ok(mut guard) = self.status.write() {
            if guard.id.as_deref() == Some(run_id) {
                guard.phase = Some(LibraryHealthScanPhase::Catalog);
                guard.total = total_work;
                guard.warnings.clone_from(&warnings);
            }
        }

        let mut catalog_issues = audit_catalog(&tracks_res.items, &albums_res.items, true);

        if let Ok(mut guard) = self.status.write() {
            if guard.id.as_deref() == Some(run_id) {
                guard.phase = Some(LibraryHealthScanPhase::Records);
                guard.processed = catalog_work;
            }
        }

        let listed_track_ids: HashSet<String> =
            tracks_res.items.iter().map(|t| t.item.id.clone()).collect();
        let listed_connections: HashSet<String> = self
            .backends
            .list()
            .into_iter()
            .filter(|b| b.enabled)
            .map(|b| b.connection_id)
            .collect();

        let mut orphans = self
            .find_orphaned_tracks(pool, &listed_track_ids, &listed_connections)
            .await;

        let prune_summary = if prune {
            if let Ok(mut guard) = self.status.write() {
                if guard.id.as_deref() == Some(run_id) {
                    guard.phase = Some(LibraryHealthScanPhase::Pruning);
                }
            }
            if degraded {
                Some(LibraryHealthPruneResult {
                    skipped_reason: Some(String::from(
                        "Pruning was skipped because a media server did not respond. Nothing was removed.",
                    )),
                    ..LibraryHealthPruneResult::default()
                })
            } else {
                let (summary, kept) = self.prune_tracks(pool, &orphans).await;
                orphans = kept;
                Some(summary)
            }
        } else {
            None
        };

        let counts = count_issues(&catalog_issues);
        let orphan_count = orphans.len();

        for orphan_id in orphans.into_iter().take(HEALTH_REPORT_ISSUE_LIMIT) {
            catalog_issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::OrphanedTrack,
                item_type: String::from("track"),
                item_id: orphan_id,
                title: String::from("Unknown track"),
                detail: String::from(
                    "MusicDeck still has a record for this track, but the media server no longer lists it",
                ),
            });
        }

        let dangling = self.count_dangling_references(pool).await;
        let finished_at = Utc::now().to_rfc3339();
        let pruned_count = prune_summary.as_ref().map_or(0, |p| p.pruned_tracks);
        let issue_total = catalog_issues.len();
        catalog_issues.truncate(HEALTH_REPORT_ISSUE_LIMIT);

        let report = LibraryHealthReport {
            completed_at: finished_at.clone(),
            degraded,
            summary: LibraryHealthReportSummary {
                albums: albums_res.items.len(),
                tracks: tracks_res.items.len(),
                artists: artists_res.items.len(),
                track_records: track_record_count.saturating_sub(pruned_count),
                missing_artwork: counts.missing_artwork,
                metadata_issues: counts.metadata_issues,
                duplicates: counts.duplicates,
                unavailable: counts.unavailable,
                incomplete_albums: counts.incomplete_albums,
                sync_mismatches: counts.sync_mismatches,
                orphaned_tracks: orphan_count,
                dangling_references: dangling,
            },
            issues: catalog_issues,
            issue_total,
            prune: prune_summary,
        };

        if let Ok(mut guard) = self.status.write() {
            if guard.id.as_deref() == Some(run_id) {
                guard.state = LibraryHealthScanState::Completed;
                guard.phase = None;
                guard.processed = total_work;
                guard.finished_at = Some(finished_at);
                guard.stale_reason = None;
                guard.report = Some(report);
            }
        }
    }

    async fn find_orphaned_tracks(
        &self,
        pool: &DbPool,
        listed: &HashSet<String>,
        listed_connections: &HashSet<String>,
    ) -> Vec<String> {
        let rows = sqlx::query(
            r"
            SELECT i.id AS id, s.connection_id AS connection_id
            FROM library_items i
            LEFT JOIN library_item_sources s ON s.library_item_id = i.id AND s.item_type = 'track'
            WHERE i.type = 'track'
            ",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let mut judged: HashMap<String, bool> = HashMap::new();
        for row in rows {
            let Ok(id) = row.try_get::<String, _>("id") else {
                continue;
            };
            if listed.contains(&id) {
                continue;
            }
            let conn_id: Option<String> = row.try_get("connection_id").ok();
            let verifiable = conn_id
                .as_ref()
                .is_none_or(|cid| listed_connections.contains(cid));
            let prev = judged.get(&id).copied().unwrap_or(true);
            judged.insert(id, prev && verifiable);
        }

        let mut orphans: Vec<String> = judged
            .into_iter()
            .filter_map(|(id, verifiable)| verifiable.then_some(id))
            .collect();
        orphans.sort();
        orphans
    }

    async fn prune_tracks(
        &self,
        pool: &DbPool,
        orphans: &[String],
    ) -> (LibraryHealthPruneResult, Vec<String>) {
        let mut summary = LibraryHealthPruneResult::default();
        let mut kept = Vec::new();
        if orphans.is_empty() {
            return (summary, kept);
        }

        let Ok(mut tx) = pool.inner().begin().await else {
            return (summary, orphans.to_vec());
        };

        for id in orphans {
            let in_playlist = sqlx::query(
                "SELECT 1 FROM playlist_items WHERE library_track_id = ? LIMIT 1",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .ok()
            .flatten()
            .is_some();

            if in_playlist {
                summary.kept_in_playlists += 1;
                kept.push(id.clone());
                continue;
            }

            let fav_del = sqlx::query("DELETE FROM favorites WHERE track_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_or(0, |r| r.rows_affected() as usize);
            let mfav_del = sqlx::query(
                "DELETE FROM media_favorites WHERE item_type = 'track' AND item_id = ?",
            )
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_or(0, |r| r.rows_affected() as usize);
            let rat_del = sqlx::query(
                "DELETE FROM media_ratings WHERE item_type = 'track' AND item_id = ?",
            )
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_or(0, |r| r.rows_affected() as usize);
            let item_del = sqlx::query(
                "DELETE FROM library_items WHERE id = ? AND type = 'track'",
            )
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_or(0, |r| r.rows_affected() as usize);

            summary.removed_favorites += fav_del + mfav_del;
            summary.removed_ratings += rat_del;
            summary.pruned_tracks += item_del;
        }

        let _ = tx.commit().await;
        (summary, kept)
    }

    async fn count_dangling_references(&self, pool: &DbPool) -> usize {
        let row = sqlx::query(
            r"
            SELECT
                (SELECT COUNT(*) FROM favorites f
                    WHERE NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = f.track_id)) +
                (SELECT COUNT(*) FROM media_favorites m
                    WHERE m.item_type IN ('track', 'album', 'artist')
                      AND NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = m.item_id)) +
                (SELECT COUNT(*) FROM media_ratings r
                    WHERE r.item_type IN ('track', 'album', 'artist')
                      AND NOT EXISTS (SELECT 1 FROM library_items i WHERE i.id = r.item_id)) AS count
            ",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten();

        row.and_then(|r| r.try_get::<i64, _>("count").ok())
            .unwrap_or(0)
            .max(0) as usize
    }
}
