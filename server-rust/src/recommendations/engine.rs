//! # Local Recommendation Engine & Multi-Factor Affinity Scoring (`recommendations::engine`)
//!
//! Ports `server/src/services/RecommendationEngine.ts`:
//! - [`AffinityVector`] and [`TasteProfile`] computed from `taste_listening_events`,
//!   `taste_recently_played`, `favorites`, and `recommendation_feedback`
//! - [`RecommendationEngine`]:
//!   - In-memory catalog feature indexing by artist, genre, and mood
//!   - Round-robin candidate pool construction (`POOL_SIZE = 2048`) preventing prolific
//!     artists from dominating the pool
//!   - Multi-factor scoring combining acoustic cosine similarity, Jaccard genre/mood overlap,
//!     artist/related-artist matching, release-year proximity, BPM proximity, bounded
//!     `[-3.0, 3.0]` track/artist/genre affinity, and explicit user feedback weights
//!   - Live 4-hour recent-play (`RECENT_PLAY_WINDOW_MS`) and max-2-per-artist diversification

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::catalog::Available;
use crate::db::DbPool;
use crate::profile::{TasteFeedbackFilter, TasteProfileManager, TasteTarget};
use crate::providers::Track;

/// Recent play suppression window (`4 hours = 14,400,000 ms`).
pub const RECENT_PLAY_WINDOW_MS: i64 = 4 * 60 * 60 * 1_000;
/// Maximum candidate pool size evaluated per seed (`2,048`).
pub const POOL_SIZE: usize = 2048;
/// Maximum cached user profiles or seed pools (`64`).
pub const CACHE_LIMIT: usize = 64;
/// TTL for cached user taste profiles and ranked candidate pools (`30,000 ms`).
pub const CACHE_TTL_MS: u64 = 30_000;

/// Acoustic similarity match supplied by the Sonic feature subsystem.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicMatch {
    pub track_id: String,
    pub cosine: f64,
}

/// Multi-dimensional affinity vector computed for a user across tracks, artists, and genres.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityVector {
    pub track_affinity: HashMap<String, f64>,
    pub artist_affinity: HashMap<String, f64>,
    pub genre_affinity: HashMap<String, f64>,
    pub explicit_weights: HashMap<String, f64>,
}

/// Compiled user taste profile used by [`RecommendationEngine`].
#[derive(Debug, Clone)]
pub struct TasteProfile {
    pub version: i64,
    pub filter: TasteFeedbackFilter,
    pub expires_at: Instant,
    pub vector: AffinityVector,
    pub hidden: HashSet<String>,
}

/// Breakdown of a candidate track's recommendation score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationScore {
    pub total: f64,
    pub sonic_score: f64,
    pub genre_overlap: f64,
    pub mood_overlap: f64,
    pub artist_bonus: f64,
    pub year_proximity: f64,
    pub bpm_proximity: f64,
    pub affinity_bonus: f64,
    pub feedback_bonus: f64,
}

/// Ranked local recommendation item returned by [`RecommendationEngine::select`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecommendation {
    pub track: Available<Track>,
    pub score: f64,
    pub reason: String,
}

/// Error returned when a requested seed track ID is not present in the local catalog snapshot.
#[derive(Debug, Clone, thiserror::Error)]
#[error("Recommendation seed is not in the local catalog")]
pub struct RecommendationSeedNotFoundError;

#[derive(Debug, Clone)]
struct TrackFeatures {
    target: TasteTarget,
    track: Available<Track>,
    genres: HashSet<String>,
    moods: HashSet<String>,
    artist_key: String,
}

#[derive(Debug, Clone)]
struct RankedCandidate {
    feature: TrackFeatures,
    score: f64,
    reason: String,
}

#[derive(Debug, Clone)]
struct CachedPool {
    version: i64,
    expires_at: Instant,
    candidates: Vec<RankedCandidate>,
}

fn normalize_tags(values: Option<&[String]>) -> HashSet<String> {
    values
        .unwrap_or(&[])
        .iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Jaccard similarity coefficient $\frac{|A \cap B|}{|A \cup B|}$ between two tag sets.
#[must_use]
pub fn tag_jaccard_overlap(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.iter().filter(|tag| right.contains(*tag)).count();
    if shared == 0 {
        return 0.0;
    }
    let union = left.len() + right.len() - shared;
    shared as f64 / union as f64
}

/// Clamps raw affinity counts into `[-3.0, 3.0]` via `clamp(value / 10.0, -3.0, 3.0)`.
#[must_use]
pub fn bounded_affinity(value: f64) -> f64 {
    (value / 10.0).clamp(-3.0, 3.0)
}

#[derive(Default)]
struct EngineCatalogState {
    tracks: HashMap<String, TrackFeatures>,
    by_genre: HashMap<String, Vec<String>>,
    by_artist: HashMap<String, Vec<String>>,
    by_mood: HashMap<String, Vec<String>>,
    profiles: HashMap<String, TasteProfile>,
    pools: HashMap<String, CachedPool>,
}

/// High-performance in-memory recommendation engine backed by SQLite taste signals.
#[derive(Clone)]
pub struct RecommendationEngine {
    db: Option<DbPool>,
    state: Arc<RwLock<EngineCatalogState>>,
}

impl std::fmt::Debug for RecommendationEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecommendationEngine").finish()
    }
}

impl RecommendationEngine {
    /// Creates a new [`RecommendationEngine`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            state: Arc::new(RwLock::new(EngineCatalogState::default())),
        }
    }

    /// Replaces the in-memory catalog snapshot and rebuilds artist, genre, and mood inverted indexes.
    pub fn replace_catalog(&self, tracks: &[Available<Track>]) {
        let Ok(mut guard) = self.state.write() else {
            return;
        };
        guard.tracks.clear();
        guard.by_genre.clear();
        guard.by_artist.clear();
        guard.by_mood.clear();
        guard.profiles.clear();
        guard.pools.clear();

        for avail in tracks {
            let track = &avail.item;
            let genres = normalize_tags(track.genres.as_deref());
            let moods = normalize_tags(track.moods.as_deref());
            let artist_key = track
                .artist_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| track.artist_name.trim().to_lowercase());

            let feature = TrackFeatures {
                target: TasteTarget::from_track(track),
                track: avail.clone(),
                genres: genres.clone(),
                moods: moods.clone(),
                artist_key: artist_key.clone(),
            };

            guard
                .by_artist
                .entry(artist_key)
                .or_default()
                .push(track.id.clone());
            for g in genres {
                guard.by_genre.entry(g).or_default().push(track.id.clone());
            }
            for m in moods {
                guard.by_mood.entry(m).or_default().push(track.id.clone());
            }
            guard.tracks.insert(track.id.clone(), feature);
        }
    }

    /// Invalidates cached profile and candidate pools for `user_id`.
    pub fn invalidate(&self, user_id: &str) {
        if let Ok(mut guard) = self.state.write() {
            guard.profiles.remove(user_id);
            let prefix = format!("{user_id}::");
            guard.pools.retain(|k, _| !k.starts_with(&prefix));
        }
    }

    /// Returns `true` if the engine currently holds a non-empty catalog snapshot.
    #[must_use]
    pub fn has_catalog(&self) -> bool {
        self.state
            .read()
            .map(|g| !g.tracks.is_empty())
            .unwrap_or(false)
    }

    async fn load_profile(&self, user_id: &str) -> TasteProfile {
        let Some(pool) = &self.db else {
            return TasteProfile {
                version: 0,
                filter: TasteFeedbackFilter::default(),
                expires_at: Instant::now() + Duration::from_millis(CACHE_TTL_MS),
                vector: AffinityVector::default(),
                hidden: HashSet::new(),
            };
        };

        let manager = TasteProfileManager::new(pool.clone());
        let version = manager.state(user_id).await.revision;

        if let Ok(guard) = self.state.read() {
            if let Some(existing) = guard.profiles.get(user_id) {
                if existing.expires_at > Instant::now() && existing.version == version {
                    return existing.clone();
                }
            }
        }

        let catalog_targets: Vec<TasteTarget> = self
            .state
            .read()
            .map(|g| g.tracks.values().map(|f| f.target.clone()).collect())
            .unwrap_or_default();

        let filter = manager.feedback_filter(user_id, &catalog_targets).await;
        let mut vector = AffinityVector::default();
        let mut hidden = HashSet::new();

        let event_rows = sqlx::query(
            r"
            SELECT
                track_id,
                COUNT(DISTINCT CASE WHEN event_type IN ('play', 'complete') THEN COALESCE(playback_session_id, id) END) AS plays,
                SUM(CASE WHEN event_type = 'skip' OR (event_type = 'progress' AND finished = 1 AND listened_seconds > 0) THEN 1 ELSE 0 END) AS skips
            FROM taste_listening_events
            WHERE user_id = ?
            GROUP BY track_id
            ",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let play_count_rows = sqlx::query(
            "SELECT track_id, COUNT(*) AS plays FROM taste_recently_played WHERE user_id = ? GROUP BY track_id",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let mut legacy_plays: HashMap<String, i64> = play_count_rows
            .into_iter()
            .filter_map(|r| {
                Some((
                    r.try_get("track_id").ok()?,
                    r.try_get::<i64, _>("plays").unwrap_or(0),
                ))
            })
            .collect();

        for row in event_rows {
            let Ok(track_id) = row.try_get::<String, _>("track_id") else {
                continue;
            };
            let plays: i64 = row.try_get("plays").unwrap_or(0);
            let skips: i64 = row.try_get("skips").unwrap_or(0);
            let leg = legacy_plays.remove(&track_id).unwrap_or(0);
            let net = (plays.max(leg) - skips) as f64;
            vector.track_affinity.insert(track_id, net);
        }

        for (track_id, plays) in legacy_plays {
            vector.track_affinity.insert(track_id, plays as f64);
        }

        let fav_rows = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

        for row in fav_rows {
            if let Ok(track_id) = row.try_get::<String, _>("track_id") {
                *vector.track_affinity.entry(track_id).or_insert(0.0) += 1.0;
            }
        }

        let feedback_rows = sqlx::query(
            "SELECT item_type, item_id, action, weight FROM recommendation_feedback WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        for row in feedback_rows {
            let item_type: String = row.try_get("item_type").unwrap_or_default();
            let item_id: String = row.try_get("item_id").unwrap_or_default();
            let action: String = row.try_get("action").unwrap_or_default();
            let weight: f64 = row.try_get("weight").unwrap_or(0.0);
            let key = format!("{item_type}:{item_id}");
            if matches!(
                action.as_str(),
                "hide" | "not-interested" | "block-artist" | "block-album"
            ) {
                hidden.insert(key);
            } else {
                *vector.explicit_weights.entry(key).or_insert(0.0) += weight * 8.0;
            }
        }

        let mut signalled_ids: HashSet<String> = vector.track_affinity.keys().cloned().collect();
        for key in vector.explicit_weights.keys() {
            if let Some(tid) = key.strip_prefix("track:") {
                signalled_ids.insert(tid.to_owned());
            }
        }

        if let Ok(guard) = self.state.read() {
            for id in signalled_ids {
                let Some(feature) = guard.tracks.get(&id) else {
                    continue;
                };
                if !filter.allows(&feature.target) {
                    continue;
                }
                let val = vector.track_affinity.get(&id).copied().unwrap_or(0.0);
                let explicit = vector
                    .explicit_weights
                    .get(&format!("track:{id}"))
                    .copied()
                    .unwrap_or(0.0);
                let artist_val = val + explicit;
                if artist_val.abs() > f64::EPSILON {
                    *vector
                        .artist_affinity
                        .entry(feature.artist_key.clone())
                        .or_insert(0.0) += artist_val;
                    for g in &feature.genres {
                        *vector.genre_affinity.entry(g.clone()).or_insert(0.0) += explicit;
                    }
                }
            }
        }

        let compiled = TasteProfile {
            version,
            filter,
            expires_at: Instant::now() + Duration::from_millis(CACHE_TTL_MS),
            vector,
            hidden,
        };

        if let Ok(mut guard) = self.state.write() {
            if guard.profiles.len() >= CACHE_LIMIT {
                if let Some(first_key) = guard.profiles.keys().next().cloned() {
                    guard.profiles.remove(&first_key);
                }
            }
            guard.profiles.insert(user_id.to_owned(), compiled.clone());
        }

        compiled
    }

    fn is_blocked(feature: &TrackFeatures, profile: &TasteProfile) -> bool {
        let track = &feature.track.item;
        !profile.filter.allows(&feature.target)
            || profile.hidden.contains(&format!("track:{}", track.id))
            || track
                .artist_id
                .as_ref()
                .is_some_and(|aid| profile.hidden.contains(&format!("artist:{aid}")))
            || track
                .album_id
                .as_ref()
                .is_some_and(|alid| profile.hidden.contains(&format!("album:{alid}")))
    }

    async fn load_recent_track_ids(&self, user_id: &str, seed_id: &str) -> HashSet<String> {
        let mut recent = HashSet::new();
        recent.insert(seed_id.to_owned());

        let Some(pool) = &self.db else {
            return recent;
        };

        let cutoff = (Utc::now() - chrono::Duration::milliseconds(RECENT_PLAY_WINDOW_MS))
            .to_rfc3339();

        if let Ok(rows) = sqlx::query(
            "SELECT DISTINCT track_id FROM taste_recently_played WHERE user_id = ? AND played_at > ?",
        )
        .bind(user_id)
        .bind(&cutoff)
        .fetch_all(pool.inner())
        .await
        {
            for r in rows {
                if let Ok(id) = r.try_get::<String, _>("track_id") {
                    recent.insert(id);
                }
            }
        }

        if let Ok(rows) = sqlx::query(
            r"
            SELECT DISTINCT track_id FROM taste_listening_events
            WHERE user_id = ? AND created_at > ?
              AND (event_type IN ('play', 'complete', 'skip') OR listened_seconds > 0)
            ",
        )
        .bind(user_id)
        .bind(&cutoff)
        .fetch_all(pool.inner())
        .await
        {
            for r in rows {
                if let Ok(id) = r.try_get::<String, _>("track_id") {
                    recent.insert(id);
                }
            }
        }

        recent
    }

    /// Selects up to `limit` (`1..=50`) recommended tracks seeded from `seed_id`.
    pub async fn select(
        &self,
        user_id: &str,
        seed_id: &str,
        limit: usize,
        exclude_ids: &[String],
        sonic_matches: &[SonicMatch],
        sonic_weight: f64,
    ) -> Result<Vec<LocalRecommendation>, RecommendationSeedNotFoundError> {
        let clamped_limit = limit.clamp(1, 50);
        let seed = {
            let guard = self
                .state
                .read()
                .map_err(|_| RecommendationSeedNotFoundError)?;
            guard
                .tracks
                .get(seed_id)
                .cloned()
                .ok_or(RecommendationSeedNotFoundError)?
        };

        let profile = self.load_profile(user_id).await;
        let recent_ids = self.load_recent_track_ids(user_id, seed_id).await;
        let pool_key = format!("{user_id}::{seed_id}::{sonic_weight:.2}");

        let cached_candidates = {
            let guard = self.state.read().ok();
            guard.and_then(|g| {
                let p = g.pools.get(&pool_key)?;
                (p.expires_at > Instant::now() && p.version == profile.version)
                    .then(|| p.candidates.clone())
            })
        };

        let candidates = if let Some(cached) = cached_candidates {
            cached
        } else {
            let built = self.build_ranked_candidates(
                &seed,
                &profile,
                &recent_ids,
                sonic_matches,
                sonic_weight,
            );
            if let Ok(mut guard) = self.state.write() {
                if guard.pools.len() >= CACHE_LIMIT {
                    if let Some(first_key) = guard.pools.keys().next().cloned() {
                        guard.pools.remove(&first_key);
                    }
                }
                guard.pools.insert(
                    pool_key,
                    CachedPool {
                        version: profile.version,
                        expires_at: Instant::now() + Duration::from_millis(CACHE_TTL_MS),
                        candidates: built.clone(),
                    },
                );
            }
            built
        };

        let mut excluded: HashSet<String> = exclude_ids.iter().cloned().collect();
        excluded.extend(recent_ids);

        let eligible: Vec<&RankedCandidate> = candidates
            .iter()
            .filter(|c| {
                !excluded.contains(&c.feature.track.item.id)
                    && !Self::is_blocked(&c.feature, &profile)
            })
            .collect();

        let mut selected = Vec::with_capacity(clamped_limit);
        let mut artist_counts: HashMap<String, usize> = HashMap::new();

        for max_per_artist in [2_usize, usize::MAX] {
            for cand in &eligible {
                let tid = &cand.feature.track.item.id;
                if excluded.contains(tid) {
                    continue;
                }
                let count = artist_counts
                    .get(&cand.feature.artist_key)
                    .copied()
                    .unwrap_or(0);
                if count >= max_per_artist {
                    continue;
                }
                selected.push(LocalRecommendation {
                    track: cand.feature.track.clone(),
                    score: cand.score,
                    reason: cand.reason.clone(),
                });
                excluded.insert(tid.clone());
                artist_counts.insert(cand.feature.artist_key.clone(), count + 1);
                if selected.len() >= clamped_limit {
                    return Ok(selected);
                }
            }
        }

        Ok(selected)
    }

    fn build_ranked_candidates(
        &self,
        seed: &TrackFeatures,
        profile: &TasteProfile,
        recent_ids: &HashSet<String>,
        sonic_matches: &[SonicMatch],
        sonic_weight: f64,
    ) -> Vec<RankedCandidate> {
        let Ok(guard) = self.state.read() else {
            return Vec::new();
        };

        let mut selected_ids = HashSet::new();
        let mut pool_features = Vec::new();

        let try_add = |id: &str,
                       pool_features: &mut Vec<TrackFeatures>,
                       selected_ids: &mut HashSet<String>| {
            if pool_features.len() >= POOL_SIZE || recent_ids.contains(id) || selected_ids.contains(id) {
                return;
            }
            if let Some(feat) = guard.tracks.get(id) {
                if !Self::is_blocked(feat, profile) {
                    selected_ids.insert(id.to_owned());
                    pool_features.push(feat.clone());
                }
            }
        };

        for m in sonic_matches {
            try_add(&m.track_id, &mut pool_features, &mut selected_ids);
        }

        for (id, &aff) in &profile.vector.track_affinity {
            if aff > 0.0 {
                try_add(id, &mut pool_features, &mut selected_ids);
            }
            if pool_features.len() >= POOL_SIZE / 4 {
                break;
            }
        }

        let mut clusters: Vec<&Vec<String>> = Vec::new();
        if let Some(list) = guard.by_artist.get(&seed.artist_key) {
            clusters.push(list);
        }
        if let Some(related_ids) = &seed.track.item.related_artist_ids {
            for rid in related_ids {
                if let Some(list) = guard.by_artist.get(rid) {
                    clusters.push(list);
                }
            }
        }
        for g in &seed.genres {
            if let Some(list) = guard.by_genre.get(g) {
                clusters.push(list);
            }
        }
        for m in &seed.moods {
            if let Some(list) = guard.by_mood.get(m) {
                clusters.push(list);
            }
        }

        let mut offset = 0_usize;
        while pool_features.len() < POOL_SIZE {
            let mut any = false;
            for cluster in &clusters {
                if let Some(tid) = cluster.get(offset) {
                    any = true;
                    try_add(tid, &mut pool_features, &mut selected_ids);
                }
            }
            if !any {
                break;
            }
            offset += 1;
        }

        for tid in guard.tracks.keys() {
            if pool_features.len() >= POOL_SIZE {
                break;
            }
            try_add(tid, &mut pool_features, &mut selected_ids);
        }

        let similarity_map: HashMap<&str, f64> = sonic_matches
            .iter()
            .map(|m| (m.track_id.as_str(), m.cosine))
            .collect();

        let seed_track = &seed.track.item;
        let mut ranked = Vec::with_capacity(pool_features.len());

        for feature in pool_features {
            let track = &feature.track.item;
            if track.id == seed_track.id || Self::is_blocked(&feature, profile) {
                continue;
            }

            let shared_genres = tag_jaccard_overlap(&seed.genres, &feature.genres);
            let shared_moods = tag_jaccard_overlap(&seed.moods, &feature.moods);
            let artist_match = feature.artist_key == seed.artist_key;
            let related_match = seed_track
                .related_artist_ids
                .as_ref()
                .is_some_and(|rel| {
                    track
                        .artist_id
                        .as_ref()
                        .is_some_and(|aid| rel.contains(aid))
                });

            let year_prox = match (seed_track.year, track.year) {
                (Some(y1), Some(y2)) => (1.0 - (f64::from((y1 - y2).abs()) / 20.0)).max(0.0),
                _ => 0.0,
            };

            let bpm_prox = match (seed_track.bpm, track.bpm) {
                (Some(b1), Some(b2)) => (1.0 - ((b1 - b2).abs() / 40.0)).max(0.0),
                _ => 0.0,
            };

            let artist_affinity = bounded_affinity(
                profile
                    .vector
                    .artist_affinity
                    .get(&feature.artist_key)
                    .copied()
                    .unwrap_or(0.0),
            );
            let mut genre_feedback = 0.0;
            for g in &feature.genres {
                genre_feedback += bounded_affinity(
                    profile.vector.genre_affinity.get(g).copied().unwrap_or(0.0),
                );
            }

            let sonic_score = similarity_map
                .get(track.id.as_str())
                .copied()
                .unwrap_or(0.0)
                .max(0.0)
                * sonic_weight;

            let track_aff = bounded_affinity(
                profile
                    .vector
                    .track_affinity
                    .get(&track.id)
                    .copied()
                    .unwrap_or(0.0),
            );

            let fb_track = profile
                .vector
                .explicit_weights
                .get(&format!("track:{}", track.id))
                .copied()
                .unwrap_or(0.0);
            let fb_artist = track
                .artist_id
                .as_ref()
                .and_then(|aid| {
                    profile
                        .vector
                        .explicit_weights
                        .get(&format!("artist:{aid}"))
                        .copied()
                })
                .unwrap_or(0.0);
            let fb_album = track
                .album_id
                .as_ref()
                .and_then(|alid| {
                    profile
                        .vector
                        .explicit_weights
                        .get(&format!("album:{alid}"))
                        .copied()
                })
                .unwrap_or(0.0);

            let score = sonic_score
                + shared_genres * 6.0
                + if artist_match {
                    4.0
                } else if related_match {
                    2.0
                } else {
                    0.0
                }
                + year_prox
                + bpm_prox * 2.0
                + shared_moods * 2.0
                + track_aff
                + artist_affinity
                + genre_feedback
                + fb_track
                + fb_artist
                + fb_album;

            let mut shared_genre_names: Vec<String> = feature
                .genres
                .iter()
                .filter(|g| seed.genres.contains(*g))
                .take(2)
                .cloned()
                .collect();
            shared_genre_names.sort();

            let mut reasons = Vec::new();
            if sonic_score > 0.0 {
                reasons.push(String::from("acoustic similarity"));
            }
            if !shared_genre_names.is_empty() {
                reasons.push(shared_genre_names.join(" & "));
            }
            if artist_match {
                reasons.push(format!("the same artist as {}", seed_track.title));
            } else if related_match {
                reasons.push(String::from("related artists"));
            }
            if artist_affinity > 0.0 {
                reasons.push(String::from("artists you play and favorite"));
            }
            if shared_moods > 0.0 {
                reasons.push(String::from("a similar mood"));
            }
            if bpm_prox > 0.5 {
                reasons.push(String::from("a similar tempo"));
            }

            let reason = if reasons.is_empty() {
                format!("Based on your library near {}", seed_track.title)
            } else {
                format!("Based on {}", reasons.join(", "))
            };

            ranked.push(RankedCandidate {
                feature,
                score,
                reason,
            });
        }

        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.feature.track.item.id.cmp(&b.feature.track.item.id))
        });
        ranked.truncate(POOL_SIZE);
        ranked
    }
}
