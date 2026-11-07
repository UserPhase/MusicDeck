//! # Sonic Vector Storage & Keyset-Paginated Cosine k-NN Search (`sonic::service`)
//!
//! Ports `server/src/services/SonicRecommendationService.ts`:
//! - [`SonicSettings`] persisted in `server_settings` (`key = 'sonic.analysis'`)
//! - [`SonicRecommendationService`]:
//!   - `put` / `remove` / `has_current` / `counts` against `sonic_vectors` joined with `library_items`
//!   - `nearest`: Keyset-paginated (`PAGE_SIZE = 128`) exact cosine similarity search over
//!     512-byte L2-normalized vectors with `MAX_CACHE_ENTRIES = 32` (`30s` TTL) and a
//!     2-permit concurrency guardrail (`tokio::sync::Semaphore`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::Semaphore;

use crate::db::DbPool;
use crate::recommendations::SonicMatch;
use crate::sonic::dsp::{
    SONIC_DIMENSIONS, decode_unit_vector, encode_unit_vector, unit_cosine_similarity,
};

/// Schema version stored in `sonic_vectors.version`.
pub const SONIC_VECTOR_VERSION: i64 = 1;
/// Page size for keyset-paginated vector scans (`128`).
pub const SONIC_SCAN_PAGE_SIZE: i64 = 128;
/// Server settings key for Sonic configuration (`"sonic.analysis"`).
pub const SONIC_SETTINGS_KEY: &str = "sonic.analysis";
/// Maximum cached `nearest()` neighbor lists (`32`).
pub const MAX_SONIC_CACHE_ENTRIES: usize = 32;

/// Configuration settings for Sonic DSP analysis and recommendation weighting.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicSettings {
    pub enabled: bool,
    pub threads: u8,
    pub weight: f64,
}

impl Default for SonicSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threads: 1,
            weight: 2.5,
        }
    }
}

/// Counts of indexed Sonic vectors vs. total library tracks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicCounts {
    pub indexed: usize,
    pub catalog: usize,
}

#[derive(Debug, Clone)]
struct CachedNeighbors {
    revision: u64,
    expires_at: Instant,
    matches: Vec<SonicMatch>,
}

/// Service managing 128-D Sonic vector persistence and cosine k-NN similarity search.
#[derive(Clone)]
pub struct SonicRecommendationService {
    db: Option<DbPool>,
    settings: Arc<RwLock<SonicSettings>>,
    schedule: Arc<RwLock<String>>,
    index_revision: Arc<AtomicU64>,
    cache: Arc<RwLock<HashMap<String, CachedNeighbors>>>,
    scan_semaphore: Arc<Semaphore>,
}

impl std::fmt::Debug for SonicRecommendationService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SonicRecommendationService")
            .field("index_revision", &self.index_revision.load(Ordering::Relaxed))
            .finish()
    }
}

impl SonicRecommendationService {
    /// Creates a new [`SonicRecommendationService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            settings: Arc::new(RwLock::new(SonicSettings::default())),
            schedule: Arc::new(RwLock::new(String::from("manual"))),
            index_revision: Arc::new(AtomicU64::new(0)),
            cache: Arc::new(RwLock::new(HashMap::new())),
            scan_semaphore: Arc::new(Semaphore::new(2)),
        }
    }

    /// Returns the active [`SonicSettings`].
    #[must_use]
    pub fn settings(&self) -> SonicSettings {
        self.settings.read().map(|g| *g).unwrap_or_default()
    }

    /// Returns the configured schedule (`"manual" | "hourly" | "nightly"`).
    #[must_use]
    pub fn schedule(&self) -> String {
        self.schedule
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| String::from("manual"))
    }

    /// Validates and persists updated [`SonicSettings`] and optional schedule.
    pub async fn configure(
        &self,
        settings: SonicSettings,
        schedule: Option<&str>,
    ) -> Result<(), String> {
        if !(1..=4).contains(&settings.threads)
            || !settings.weight.is_finite()
            || !(0.0..=6.0).contains(&settings.weight)
        {
            return Err(String::from("Invalid sonic analysis settings"));
        }

        if let Some(sched) = schedule {
            if !matches!(sched, "manual" | "hourly" | "nightly") {
                return Err(String::from("Invalid sonic analysis settings"));
            }
            if let Ok(mut guard) = self.schedule.write() {
                *guard = sched.to_owned();
            }
        }

        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let val_str =
                serde_json::to_string(&settings).unwrap_or_else(|_| String::from("{}"));
            sqlx::query(
                r"
                INSERT INTO server_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(SONIC_SETTINGS_KEY)
            .bind(val_str)
            .bind(now)
            .execute(pool.inner())
            .await
            .map_err(|e| e.to_string())?;
        }

        if let Ok(mut guard) = self.settings.write() {
            *guard = settings;
        }
        self.invalidate();
        Ok(())
    }

    fn invalidate(&self) {
        self.index_revision.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut guard) = self.cache.write() {
            guard.clear();
        }
    }

    /// Queries `library_items.content_revision` for `track_id`.
    pub async fn content_revision(&self, track_id: &str) -> Option<Option<String>> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query(
            "SELECT content_revision FROM library_items WHERE id = ? AND type = 'track'",
        )
        .bind(track_id)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;
        Some(row.try_get("content_revision").ok())
    }

    /// Returns `true` if `sonic_vectors` already has a current vector matching `file_revision` and `content_revision`.
    pub async fn has_current(
        &self,
        track_id: &str,
        file_revision: &str,
        content_revision: Option<&str>,
    ) -> bool {
        let Some(pool) = &self.db else {
            return false;
        };
        sqlx::query(
            r"
            SELECT 1 FROM sonic_vectors
            WHERE track_id = ?
              AND version = ?
              AND file_revision = ?
              AND content_revision IS ?
            ",
        )
        .bind(track_id)
        .bind(SONIC_VECTOR_VERSION)
        .bind(file_revision)
        .bind(content_revision)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .is_some()
    }

    /// Removes the stored Sonic vector for `track_id`.
    pub async fn remove(&self, track_id: &str) {
        let Some(pool) = &self.db else {
            return;
        };
        if let Ok(res) = sqlx::query("DELETE FROM sonic_vectors WHERE track_id = ?")
            .bind(track_id)
            .execute(pool.inner())
            .await
        {
            if res.rows_affected() > 0 {
                self.invalidate();
            }
        }
    }

    /// Encodes and upserts a 128-D feature vector into `sonic_vectors`.
    pub async fn put(
        &self,
        track_id: &str,
        file_revision: &str,
        content_revision: Option<&str>,
        features: &[f32; SONIC_DIMENSIONS],
    ) -> Result<bool, String> {
        if !self.settings().enabled {
            return Ok(false);
        }
        let current_content = self.content_revision(track_id).await;
        if current_content.as_ref().map(|c| c.as_deref()) != Some(content_revision) {
            return Ok(false);
        }
        let Some(pool) = &self.db else {
            return Ok(false);
        };

        let encoded = encode_unit_vector(features)?;
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r"
            INSERT INTO sonic_vectors (
                track_id, version, content_revision, file_revision, vector, analyzed_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(track_id) DO UPDATE SET
                version = excluded.version,
                content_revision = excluded.content_revision,
                file_revision = excluded.file_revision,
                vector = excluded.vector,
                analyzed_at = excluded.analyzed_at
            ",
        )
        .bind(track_id)
        .bind(SONIC_VECTOR_VERSION)
        .bind(content_revision)
        .bind(file_revision)
        .bind(encoded)
        .bind(now)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        self.invalidate();
        Ok(true)
    }

    /// Returns the number of indexed tracks vs. total catalog tracks.
    pub async fn counts(&self) -> SonicCounts {
        let Some(pool) = &self.db else {
            return SonicCounts::default();
        };
        let indexed: i64 = sqlx::query(
            r"
            SELECT COUNT(*) AS count
            FROM sonic_vectors v
            JOIN library_items i ON i.id = v.track_id AND i.content_revision IS v.content_revision
            WHERE v.version = ?
            ",
        )
        .bind(SONIC_VECTOR_VERSION)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("count").ok())
        .unwrap_or(0);

        let catalog: i64 = sqlx::query(
            "SELECT COUNT(*) AS count FROM library_items WHERE type = 'track'",
        )
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("count").ok())
        .unwrap_or(0);

        SonicCounts {
            indexed: indexed.max(0) as usize,
            catalog: catalog.max(0) as usize,
        }
    }

    /// Finds the top `limit` (`1..=128`) nearest acoustic neighbors to `track_id` by cosine similarity.
    pub async fn nearest(
        &self,
        track_id: &str,
        limit: usize,
    ) -> Result<Vec<SonicMatch>, String> {
        if !(1..=128).contains(&limit) {
            return Err(String::from("Invalid sonic neighbor limit"));
        }
        let cfg = self.settings();
        if !cfg.enabled || cfg.weight == 0.0 {
            return Ok(Vec::new());
        }

        let cache_key = format!("{track_id}:{limit}");
        let rev = self.index_revision.load(Ordering::Acquire);

        if let Ok(guard) = self.cache.read() {
            if let Some(entry) = guard.get(&cache_key) {
                if entry.revision == rev && entry.expires_at > Instant::now() {
                    return Ok(entry.matches.clone());
                }
            }
        }

        let Ok(_permit) = self.scan_semaphore.try_acquire() else {
            return Ok(Vec::new());
        };

        let matches = self.search_vectors(track_id, limit).await;
        if self.index_revision.load(Ordering::Acquire) == rev {
            if let Ok(mut guard) = self.cache.write() {
                if guard.len() >= MAX_SONIC_CACHE_ENTRIES {
                    if let Some(first_key) = guard.keys().next().cloned() {
                        guard.remove(&first_key);
                    }
                }
                guard.insert(
                    cache_key,
                    CachedNeighbors {
                        revision: rev,
                        expires_at: Instant::now() + Duration::from_secs(30),
                        matches: matches.clone(),
                    },
                );
            }
        }

        Ok(if self.settings().enabled {
            matches
        } else {
            Vec::new()
        })
    }

    async fn search_vectors(&self, track_id: &str, limit: usize) -> Vec<SonicMatch> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };

        let seed_row = sqlx::query(
            r"
            SELECT v.vector
            FROM sonic_vectors v
            JOIN library_items i ON i.id = v.track_id AND i.content_revision IS v.content_revision
            WHERE v.track_id = ? AND v.version = ?
            ",
        )
        .bind(track_id)
        .bind(SONIC_VECTOR_VERSION)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten();

        let Some(seed_row) = seed_row else {
            return Vec::new();
        };
        let Ok(seed_bytes) = seed_row.try_get::<Vec<u8>, _>("vector") else {
            return Vec::new();
        };
        let Some(source_vec) = decode_unit_vector(&seed_bytes) else {
            return Vec::new();
        };

        let mut best: Vec<SonicMatch> = Vec::with_capacity(limit + 1);
        let mut cursor = String::new();

        while self.settings().enabled {
            let rows = sqlx::query(
                r"
                SELECT v.track_id, v.vector
                FROM sonic_vectors v
                JOIN library_items i ON i.id = v.track_id AND i.content_revision IS v.content_revision
                WHERE v.version = ? AND v.track_id > ?
                ORDER BY v.track_id
                LIMIT ?
                ",
            )
            .bind(SONIC_VECTOR_VERSION)
            .bind(&cursor)
            .bind(SONIC_SCAN_PAGE_SIZE)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

            let row_count = rows.len();
            for row in rows {
                let Ok(candidate_id) = row.try_get::<String, _>("track_id") else {
                    continue;
                };
                cursor.clone_from(&candidate_id);
                if candidate_id == track_id {
                    continue;
                }
                let Ok(vec_bytes) = row.try_get::<Vec<u8>, _>("vector") else {
                    continue;
                };
                let Some(cand_vec) = decode_unit_vector(&vec_bytes) else {
                    continue;
                };
                let Some(cosine) = unit_cosine_similarity(&source_vec, &cand_vec) else {
                    continue;
                };

                if best.len() == limit && cosine <= best[best.len() - 1].cosine {
                    continue;
                }
                let pos = best
                    .iter()
                    .position(|m| cosine > m.cosine)
                    .unwrap_or(best.len());
                best.insert(
                    pos,
                    SonicMatch {
                        track_id: candidate_id,
                        cosine,
                    },
                );
                if best.len() > limit {
                    best.pop();
                }
            }

            if (row_count as i64) < SONIC_SCAN_PAGE_SIZE {
                break;
            }
            tokio::task::yield_now().await;
        }

        best
    }
}
