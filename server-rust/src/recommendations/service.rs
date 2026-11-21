//! # Personalized Recommendation Feeds, Radio, Discovery Seeds & Playlist Suggestions (`recommendations::service`)
//!
//! Ports `server/src/domain/recommendations.ts` and `server/src/domain/playlist-recommendations.ts`:
//! - [`RecommendationKind`] (`continue-listening`, `favorites-mix`, `forgotten-favorites`,
//!   `discover`, `similar-tracks`, `similar-artists`, `radio-track`, `radio-artist`, `radio-album`)
//! - [`RecommendationService`] & [`RecommendationRegistry`]
//! - Playlist-seeded library and external suggestions

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tokio::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

use crate::catalog::{AvailabilityState, Available, CatalogService, normalize_music_text};
use crate::catalog::snapshot::{CatalogSnapshot, CatalogSnapshots};
use crate::db::DbPool;
use crate::playlists::PlaylistTrack;
use crate::profile::{TasteProfileManager, TasteTarget};
use crate::providers::Track;
use crate::recommendations::engine::{LocalRecommendation, RecommendationEngine};
use crate::search::{UnifiedSearchResult, to_track_search_result};
use crate::services::recently_played::{can_use_provider_history, listening_window_start_iso};

/// Recommendation feed or radio mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationKind {
    ContinueListening,
    FavoritesMix,
    ForgottenFavorites,
    Discover,
    SimilarTracks,
    SimilarArtists,
    RadioTrack,
    RadioArtist,
    RadioAlbum,
}

impl RecommendationKind {
    /// Parses a string into a [`RecommendationKind`].
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "continue-listening" => Some(Self::ContinueListening),
            "favorites-mix" => Some(Self::FavoritesMix),
            "forgotten-favorites" => Some(Self::ForgottenFavorites),
            "discover" => Some(Self::Discover),
            "similar-tracks" => Some(Self::SimilarTracks),
            "similar-artists" => Some(Self::SimilarArtists),
            "radio-track" => Some(Self::RadioTrack),
            "radio-artist" => Some(Self::RadioArtist),
            "radio-album" => Some(Self::RadioAlbum),
            _ => None,
        }
    }

    /// Human-readable section title for home/discovery UI carousels.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::ContinueListening => "Continue listening",
            Self::FavoritesMix => "Made for you",
            Self::ForgottenFavorites => "Forgotten favorites",
            Self::Discover => "Discover something new",
            Self::SimilarArtists => "Similar artists",
            _ => "Recommended",
        }
    }
}

/// Optional seed entity for `similar-*` and `radio-*` recommendation queries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSeed {
    /// `"track" | "artist" | "album"`.
    #[serde(rename = "type")]
    pub seed_type: String,
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
}

/// Context passed to [`RecommendationProvider::recommend`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationContext {
    pub user_id: String,
    pub kind: RecommendationKind,
    pub limit: usize,
    #[serde(default)]
    pub seed: Option<RecommendationSeed>,
}

/// Named recommendation carousel section returned by `/api/recommendations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSection {
    pub id: RecommendationKind,
    pub title: String,
    pub items: Vec<UnifiedSearchResult>,
}

/// Deliberate user artist seed used to anchor external discovery queries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySeed {
    pub name: String,
    pub score: f64,
}

/// User feedback action on a recommended item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedbackAction {
    Hide,
    NotInterested,
    MoreLikeThis,
    LessLikeThis,
    BlockArtist,
    BlockAlbum,
}

impl FeedbackAction {
    /// Parses a feedback action string.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "hide" => Some(Self::Hide),
            "not-interested" => Some(Self::NotInterested),
            "more-like-this" => Some(Self::MoreLikeThis),
            "less-like-this" => Some(Self::LessLikeThis),
            "block-artist" => Some(Self::BlockArtist),
            "block-album" => Some(Self::BlockAlbum),
            _ => None,
        }
    }

    /// Canonical lowercase kebab-case identifier.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hide => "hide",
            Self::NotInterested => "not-interested",
            Self::MoreLikeThis => "more-like-this",
            Self::LessLikeThis => "less-like-this",
            Self::BlockArtist => "block-artist",
            Self::BlockAlbum => "block-album",
        }
    }

    /// Numeric weight persisted in `recommendation_feedback.weight`.
    #[must_use]
    pub const fn weight(self) -> f64 {
        match self {
            Self::MoreLikeThis => 1.0,
            Self::LessLikeThis => -0.5,
            Self::Hide | Self::NotInterested | Self::BlockArtist | Self::BlockAlbum => -1.0,
        }
    }
}

#[derive(Debug, Clone)]
struct TasteEntry {
    track_id: String,
    score: f64,
    play_count: i64,
    #[allow(dead_code)]
    favorite: bool,
    last_played_at: Option<String>,
    artist_id: Option<String>,
    artist_name: String,
    album_id: Option<String>,
    #[allow(dead_code)]
    album_name: String,
}

fn clamp_limit(limit: usize) -> usize {
    if limit == 0 {
        12
    } else {
        limit.clamp(1, 30)
    }
}

fn reason_for(kind: RecommendationKind, entry: Option<&TasteEntry>) -> String {
    match kind {
        RecommendationKind::ContinueListening => String::from("Recently played"),
        RecommendationKind::FavoritesMix => String::from("From your favorites"),
        RecommendationKind::ForgottenFavorites => entry
            .map(|e| format!("A deep cut from {}", e.artist_name))
            .unwrap_or_else(|| String::from("A deep cut from your library")),
        RecommendationKind::Discover => entry
            .map(|e| format!("Because you listen to {}", e.artist_name))
            .unwrap_or_else(|| String::from("Discover something new")),
        RecommendationKind::SimilarArtists => entry
            .map(|e| format!("Similar to {}", e.artist_name))
            .unwrap_or_else(|| String::from("Similar artists")),
        _ => String::from("Recommended for you"),
    }
}

fn with_reason(mut item: UnifiedSearchResult, reason: String) -> UnifiedSearchResult {
    item.metadata.recommendation_reason = Some(reason);
    item
}

/// Diversifies a ranked list of [`UnifiedSearchResult`] items so no single artist or album
/// exceeds `max_per_artist` / `max_per_album` before filling remaining slots from overflow.
#[must_use]
pub fn diversify_results(
    items: Vec<UnifiedSearchResult>,
    limit: usize,
    max_per_artist: usize,
    max_per_album: usize,
) -> Vec<UnifiedSearchResult> {
    let mut by_artist: HashMap<String, usize> = HashMap::new();
    let mut by_album: HashMap<String, usize> = HashMap::new();
    let mut selected = Vec::with_capacity(limit);
    let mut overflow = Vec::new();

    for item in items {
        let artist_key = item
            .metadata
            .artist_id
            .clone()
            .or_else(|| item.artist.clone())
            .unwrap_or_else(|| item.title.clone());
        let album_key = item
            .metadata
            .album_id
            .clone()
            .or_else(|| item.album.clone())
            .unwrap_or_else(|| item.id.clone());

        let a_count = by_artist.get(&artist_key).copied().unwrap_or(0);
        let al_count = by_album.get(&album_key).copied().unwrap_or(0);

        if a_count >= max_per_artist || al_count >= max_per_album {
            overflow.push(item);
            continue;
        }

        by_artist.insert(artist_key, a_count + 1);
        by_album.insert(album_key, al_count + 1);
        selected.push(item);
        if selected.len() >= limit {
            return selected;
        }
    }

    for item in overflow {
        selected.push(item);
        if selected.len() >= limit {
            break;
        }
    }

    selected
}

/// Trait implemented by built-in and plugin recommendation providers.
#[async_trait]
pub trait RecommendationProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    async fn recommend(
        &self,
        context: &RecommendationContext,
    ) -> Result<Vec<UnifiedSearchResult>, String>;
}

/// Core recommendation service orchestrating [`RecommendationEngine`], taste scoring,
/// feedback persistence, and discovery seed extraction.
#[derive(Clone)]
pub struct RecommendationService {
    db: Option<DbPool>,
    engine: RecommendationEngine,
    playback_engine: RecommendationEngine,
    playback_catalog: Arc<Mutex<Option<PlaybackCatalog>>>,
}

enum PlaybackCatalog {
    LibraryWindow(Weak<CatalogSnapshot<Track>>),
    MappedUntil(Instant),
}

impl std::fmt::Debug for RecommendationService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecommendationService").finish()
    }
}

impl RecommendationService {
    /// Creates a new [`RecommendationService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let engine = RecommendationEngine::new(db.clone());
        Self {
            playback_engine: RecommendationEngine::new(db.clone()),
            playback_catalog: Arc::new(Mutex::new(None)),
            db,
            engine,
        }
    }

    /// Returns a reference to the underlying [`RecommendationEngine`].
    #[must_use]
    pub const fn engine(&self) -> &RecommendationEngine {
        &self.engine
    }

    /// Invalidates cached listening taste profiles for `user_id`.
    pub fn invalidate_listening_taste(&self, user_id: &str) {
        self.engine.invalidate(user_id);
        self.playback_engine.invalidate(user_id);
    }

    /// Refreshes the in-memory catalog snapshot from `catalog`.
    pub async fn refresh_catalog(&self, catalog: &CatalogService) {
        let list = catalog.tracks_for_window().await;
        self.engine.replace_catalog(&list.items);
    }

    /// Selects autoplay continuation tracks seeded from `seed_id`.
    pub async fn autoplay(
        &self,
        catalog: &CatalogService,
        user_id: &str,
        seed_id: &str,
        limit: usize,
        exclude_ids: &[String],
    ) -> Vec<UnifiedSearchResult> {
        if !self.engine.has_catalog() {
            self.refresh_catalog(catalog).await;
        }
        let Ok(selected) = self
            .engine
            .select(user_id, seed_id, limit, exclude_ids, &[], 0.0)
            .await
        else {
            return Vec::new();
        };

        Self::autoplay_results(selected)
    }

    /// Ranks already-mapped library tracks for playback without creating catalog identities.
    pub(crate) async fn playback_autoplay(
        &self,
        catalog: &CatalogService,
        snapshots: &CatalogSnapshots,
        user_id: &str,
        seed_id: &str,
        limit: usize,
        exclude_ids: &[String],
        playlist_id: Option<&str>,
    ) -> Vec<UnifiedSearchResult> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let taste = TasteProfileManager::new(pool.clone());
        if taste.state(user_id).await.private_listening {
            return Vec::new();
        }
        {
            let mut loaded = self.playback_catalog.lock().await;
            if let Some(snapshot) = snapshots.cached_tracks() {
                let source = Arc::downgrade(&snapshot);
                let already_loaded = matches!(
                    loaded.as_ref(), Some(PlaybackCatalog::LibraryWindow(current)) if current.ptr_eq(&source)
                );
                if !already_loaded {
                    self.playback_engine.replace_catalog(&snapshot.items);
                    *loaded = Some(PlaybackCatalog::LibraryWindow(source));
                }
            } else if !matches!(
                loaded.as_ref(), Some(PlaybackCatalog::MappedUntil(deadline)) if *deadline > Instant::now()
            ) {
                let tracks = catalog.list_mapped_tracks().await;
                self.playback_engine.replace_catalog(&tracks.items);
                let ttl = if tracks.items.is_empty() || tracks.degraded {
                    5
                } else {
                    30
                };
                *loaded = Some(PlaybackCatalog::MappedUntil(
                    Instant::now() + Duration::from_secs(ttl),
                ));
            }
        }

        let Some(seed) = self.playback_engine.track_target(seed_id) else {
            return Vec::new();
        };
        let now = Utc::now().to_rfc3339();
        if taste
            .assess_exclusion(
                user_id,
                seed_id,
                &now,
                Some(&now),
                false,
                false,
                playlist_id,
                seed.title.as_deref(),
                seed.artist.as_deref(),
            )
            .await
            .excluded
        {
            return Vec::new();
        }

        let selected = self
            .playback_engine
            .select(user_id, seed_id, limit, exclude_ids, &[], 0.0)
            .await
            .unwrap_or_default();
        Self::autoplay_results(selected)
    }

    fn autoplay_results(selected: Vec<LocalRecommendation>) -> Vec<UnifiedSearchResult> {
        selected
            .into_iter()
            .map(|rec| {
                let search_res = to_track_search_result(
                    &rec.track.item,
                    Some(rec.track.availability),
                    rec.track.sources,
                );
                with_reason(search_res, rec.reason)
            })
            .collect()
    }

    /// Persists user recommendation feedback (`more-like-this`, `less-like-this`, `hide`, etc.).
    pub async fn set_feedback(
        &self,
        user_id: &str,
        action: FeedbackAction,
        item_type: &str,
        item_id: &str,
        title: Option<&str>,
        artist: Option<&str>,
        album: Option<&str>,
    ) {
        let Some(pool) = &self.db else {
            return;
        };

        if matches!(
            action,
            FeedbackAction::MoreLikeThis | FeedbackAction::LessLikeThis
        ) {
            let _ = sqlx::query(
                r"
                DELETE FROM recommendation_feedback
                WHERE user_id = ? AND item_type = ? AND item_id = ?
                  AND action IN ('more-like-this', 'less-like-this')
                ",
            )
            .bind(user_id)
            .bind(item_type)
            .bind(item_id)
            .execute(pool.inner())
            .await;
        }

        let now = Utc::now().to_rfc3339();
        let _ = sqlx::query(
            r"
            INSERT INTO recommendation_feedback (
                user_id, item_type, item_id, action, weight, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, item_type, item_id, action) DO UPDATE SET
                weight = excluded.weight,
                updated_at = excluded.updated_at
            ",
        )
        .bind(user_id)
        .bind(item_type)
        .bind(item_id)
        .bind(action.as_str())
        .bind(action.weight())
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await;

        let manager = TasteProfileManager::new(pool.clone());
        let resolved = manager
            .resolve(TasteTarget {
                id: item_id.to_owned(),
                item_type: Some(item_type.to_owned()),
                title: title.map(str::to_owned),
                artist: artist.map(str::to_owned),
                album: album.map(str::to_owned),
                artist_id: None,
                album_id: None,
            })
            .await;

        let _ = sqlx::query(
            r"
            UPDATE recommendation_feedback
            SET identity_title = COALESCE(?, identity_title),
                identity_artist = COALESCE(?, identity_artist),
                identity_album = COALESCE(?, identity_album)
            WHERE user_id = ? AND item_type = ? AND item_id = ? AND action = ?
            ",
        )
        .bind(resolved.title)
        .bind(resolved.artist)
        .bind(resolved.album)
        .bind(user_id)
        .bind(item_type)
        .bind(item_id)
        .bind(action.as_str())
        .execute(pool.inner())
        .await;

        self.invalidate_listening_taste(user_id);
    }

    async fn compute_taste_entries(
        &self,
        user_id: &str,
        library_tracks: &[Available<Track>],
    ) -> Vec<TasteEntry> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let cutoff = listening_window_start_iso();

        let fav_rows = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();
        let favorites: HashSet<String> = fav_rows
            .into_iter()
            .filter_map(|r| r.try_get("track_id").ok())
            .collect();

        let recent_rows = sqlx::query(
            r"
            SELECT track_id, COUNT(*) AS play_count, MAX(played_at) AS last_played_at
            FROM taste_recently_played
            WHERE user_id = ? AND played_at >= ?
            GROUP BY track_id
            ",
        )
        .bind(user_id)
        .bind(&cutoff)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let event_rows = sqlx::query(
            r"
            SELECT
                track_id,
                SUM(CASE event_type
                    WHEN 'complete' THEN 2.0 * COALESCE(completion_ratio, 1.0)
                    WHEN 'skip' THEN -2.0
                    ELSE 1.0
                END) AS score_delta,
                SUM(CASE WHEN event_type = 'complete' THEN 1 ELSE 0 END) AS completed_count,
                MAX(CASE WHEN event_type = 'complete' THEN created_at END) AS last_completed_at
            FROM taste_listening_events
            WHERE user_id = ? AND created_at >= ? AND event_type IN ('play', 'skip', 'complete')
            GROUP BY track_id
            ",
        )
        .bind(user_id)
        .bind(&cutoff)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let mut by_track: HashMap<String, (f64, i64, bool, Option<String>)> = HashMap::new();

        for r in recent_rows {
            let Ok(tid) = r.try_get::<String, _>("track_id") else {
                continue;
            };
            let play_count: i64 = r.try_get("play_count").unwrap_or(0);
            let last_played: Option<String> = r.try_get("last_played_at").ok();
            by_track.insert(
                tid.clone(),
                (
                    (play_count * 2) as f64,
                    play_count,
                    favorites.contains(&tid),
                    last_played,
                ),
            );
        }

        for r in event_rows {
            let Ok(tid) = r.try_get::<String, _>("track_id") else {
                continue;
            };
            let score_delta: f64 = r.try_get("score_delta").unwrap_or(0.0);
            let completed_count: i64 = r.try_get("completed_count").unwrap_or(0);
            let last_completed: Option<String> = r.try_get("last_completed_at").ok();

            let entry = by_track
                .entry(tid.clone())
                .or_insert((0.0, 0, favorites.contains(&tid), None));
            let base_score = if completed_count > 0 { 0.0 } else { entry.0 };
            entry.0 = base_score + score_delta;
            entry.1 = entry.1.max(completed_count);
            if let Some(lc) = last_completed {
                if entry.3.as_ref().is_none_or(|prev| lc > *prev) {
                    entry.3 = Some(lc);
                }
            }
        }

        let manager = TasteProfileManager::new(pool.clone());
        let use_provider = can_use_provider_history(pool).await.unwrap_or(false)
            && manager.can_use_provider_history(user_id).await;

        if use_provider {
            for avail in library_tracks {
                let track = &avail.item;
                let Some(ref lp) = track.last_played_at else {
                    continue;
                };
                if lp.as_str() < cutoff.as_str() {
                    continue;
                }
                let entry = by_track.entry(track.id.clone()).or_insert((
                    2.0,
                    1,
                    favorites.contains(&track.id),
                    Some(lp.clone()),
                ));
                if entry.3.as_ref().is_none_or(|prev| lp > prev) {
                    entry.3 = Some(lp.clone());
                }
            }
        }

        let catalog_by_id: HashMap<&str, &Available<Track>> = library_tracks
            .iter()
            .map(|t| (t.item.id.as_str(), t))
            .collect();
        let filter = manager.feedback_filter(user_id, &[]).await;

        let mut entries = Vec::new();
        for (tid, (score, play_count, favorite, last_played_at)) in by_track {
            let Some(avail) = catalog_by_id.get(tid.as_str()) else {
                continue;
            };
            let track = &avail.item;
            if !filter.allows(&TasteTarget::from_track(track)) {
                continue;
            }
            entries.push(TasteEntry {
                track_id: tid,
                score,
                play_count,
                favorite,
                last_played_at,
                artist_id: track.artist_id.clone(),
                artist_name: track.artist_name.clone(),
                album_id: track.album_id.clone(),
                album_name: track.album_name.clone(),
            });
        }

        entries
    }

    /// Extracts up to `result_limit` (`1..=3`) deliberate user artist seeds for external discovery.
    pub async fn discovery_seeds(
        &self,
        user_id: &str,
        tracks: &[Available<Track>],
        result_limit: usize,
    ) -> Vec<DiscoverySeed> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let manager = TasteProfileManager::new(pool.clone());
        let filter = manager.feedback_filter(user_id, &[]).await;

        let mut artists: HashMap<String, DiscoverySeed> = HashMap::new();
        let mut add_seed = |name: &str, score: f64| {
            let primary = name
                .split([';', '•'])
                .next()
                .unwrap_or(name)
                .split(" / ")
                .next()
                .unwrap_or(name)
                .trim();
            let key = primary.nfkc().collect::<String>().to_lowercase();
            if key.is_empty() || primary.eq_ignore_ascii_case("unknown artist") {
                return;
            }
            let target = TasteTarget {
                id: format!("name:{key}"),
                item_type: Some(String::from("artist")),
                title: Some(primary.to_owned()),
                artist: Some(primary.to_owned()),
                album: None,
                artist_id: None,
                album_id: None,
            };
            if !filter.allows(&target) {
                return;
            }
            let entry = artists.entry(key).or_insert_with(|| DiscoverySeed {
                name: primary.to_owned(),
                score: 0.0,
            });
            entry.score += score;
        };

        let allowed_tracks: Vec<Available<Track>> = tracks
            .iter()
            .filter(|t| filter.allows(&TasteTarget::from_track(&t.item)))
            .cloned()
            .collect();

        for entry in self.compute_taste_entries(user_id, &allowed_tracks).await {
            add_seed(&entry.artist_name, entry.score);
        }

        let fav_rows = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();
        let fav_ids: HashSet<String> = fav_rows
            .into_iter()
            .filter_map(|r| r.try_get("track_id").ok())
            .collect();

        for avail in &allowed_tracks {
            if fav_ids.contains(&avail.item.id) {
                add_seed(&avail.item.artist_name, 8.0);
            }
        }

        let mut out: Vec<DiscoverySeed> = artists
            .into_values()
            .filter(|s| s.score > 0.0)
            .collect();
        out.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        out.truncate(result_limit.clamp(1, 3));
        out
    }

    /// Generates ranked recommendations for `context`.
    pub async fn recommend(
        &self,
        catalog: &CatalogService,
        context: &RecommendationContext,
    ) -> Vec<UnifiedSearchResult> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let limit = clamp_limit(context.limit);
        let manager = TasteProfileManager::new(pool.clone());
        let filter = manager.feedback_filter(&context.user_id, &[]).await;

        let all_tracks = catalog.list_tracks().await.items;
        let tracks: Vec<Available<Track>> = all_tracks
            .into_iter()
            .filter(|t| filter.allows(&TasteTarget::from_track(&t.item)))
            .collect();

        let taste = self.compute_taste_entries(&context.user_id, &tracks).await;
        let taste_by_track: HashMap<String, TasteEntry> = taste
            .iter()
            .map(|e| (e.track_id.clone(), e.clone()))
            .collect();

        let fav_rows = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?")
            .bind(&context.user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();
        let favorite_ids: HashSet<String> = fav_rows
            .into_iter()
            .filter_map(|r| r.try_get("track_id").ok())
            .collect();

        let mut artist_totals: HashMap<String, f64> = HashMap::new();
        let mut album_totals: HashMap<String, f64> = HashMap::new();
        for e in &taste {
            if let Some(ref aid) = e.artist_id {
                *artist_totals.entry(aid.clone()).or_insert(0.0) += e.score.max(0.0);
            }
            if let Some(ref alid) = e.album_id {
                *album_totals.entry(alid.clone()).or_insert(0.0) += e.score.max(0.0);
            }
        }

        let mut top_artists: Vec<(String, f64)> = artist_totals.into_iter().collect();
        top_artists.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_artist_ids: HashSet<String> =
            top_artists.into_iter().take(5).map(|(k, _)| k).collect();

        let mut top_albums: Vec<(String, f64)> = album_totals.into_iter().collect();
        top_albums.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_album_ids: HashSet<String> =
            top_albums.into_iter().take(5).map(|(k, _)| k).collect();

        let fb_rows = sqlx::query(
            "SELECT item_id, SUM(weight) AS w FROM recommendation_feedback WHERE user_id = ? GROUP BY item_id",
        )
        .bind(&context.user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();
        let fb_weights: HashMap<String, f64> = fb_rows
            .into_iter()
            .filter_map(|r| {
                Some((
                    r.try_get("item_id").ok()?,
                    r.try_get::<f64, _>("w").unwrap_or(0.0),
                ))
            })
            .collect();

        let provider_history_personal = can_use_provider_history(pool).await.unwrap_or(false)
            && manager.can_use_provider_history(&context.user_id).await;

        let local_lifetime: HashMap<String, i64> = if matches!(
            context.kind,
            RecommendationKind::Discover | RecommendationKind::ForgottenFavorites
        ) {
            sqlx::query(
                r"
                SELECT track_id, COUNT(*) AS play_count
                FROM taste_listening_events
                WHERE user_id = ? AND event_type = 'complete'
                GROUP BY track_id
                ",
            )
            .bind(&context.user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| {
                Some((
                    r.try_get("track_id").ok()?,
                    r.try_get::<i64, _>("play_count").unwrap_or(0),
                ))
            })
            .collect()
        } else {
            HashMap::new()
        };

        let now_ms = Utc::now().timestamp_millis();
        let mut candidates: Vec<(Available<Track>, Option<TasteEntry>, f64)> = Vec::new();

        for avail in tracks {
            let track = &avail.item;
            let entry = taste_by_track.get(&track.id);
            let age_days = entry
                .and_then(|e| e.last_played_at.as_deref())
                .and_then(|iso| DateTime::parse_from_rfc3339(iso).ok())
                .map_or(f64::INFINITY, |dt| {
                    (now_ms - dt.timestamp_millis()) as f64 / 86_400_000.0
                });

            let mut score = entry.map_or(0.0, |e| e.score);
            let provider_plays = if provider_history_personal {
                track.play_count.unwrap_or(0) as i64
            } else {
                0
            };
            let lifetime_plays = provider_plays
                .max(local_lifetime.get(&track.id).copied().unwrap_or(0))
                .max(entry.map_or(0, |e| e.play_count));

            let matches_artist = track
                .artist_id
                .as_ref()
                .is_some_and(|aid| top_artist_ids.contains(aid));
            let matches_album = track
                .album_id
                .as_ref()
                .is_some_and(|alid| top_album_ids.contains(alid));

            match context.kind {
                RecommendationKind::ContinueListening => {
                    score = if entry.and_then(|e| e.last_played_at.as_ref()).is_some()
                        && age_days <= 45.0
                    {
                        45.0 - age_days
                    } else {
                        -100.0
                    };
                }
                RecommendationKind::FavoritesMix => {
                    score = if favorite_ids.contains(&track.id) {
                        20.0 + score
                    } else {
                        -100.0
                    };
                }
                RecommendationKind::ForgottenFavorites => {
                    let affinity = (if matches_artist { 10.0 } else { 0.0 })
                        + (if matches_album { 3.0 } else { 0.0 });
                    score = if affinity > 0.0 && lifetime_plays <= 1 {
                        affinity + if lifetime_plays == 0 { 3.0 } else { 0.0 }
                    } else if taste.is_empty() && lifetime_plays == 0 {
                        1.0
                    } else {
                        -100.0
                    };
                }
                RecommendationKind::Discover => {
                    score = if lifetime_plays == 0 {
                        (if matches_artist { 8.0 } else { 2.0 })
                            + (if matches_album { 3.0 } else { 0.0 })
                    } else {
                        -100.0
                    };
                }
                RecommendationKind::RadioArtist | RecommendationKind::SimilarArtists => {
                    let seed_artist_match = context.seed.as_ref().is_some_and(|s| {
                        (s.artist_id.is_some() && s.artist_id == track.artist_id)
                            || s.artist.as_deref() == Some(track.artist_name.as_str())
                    });
                    score = if seed_artist_match {
                        10.0
                    } else if matches_artist {
                        4.0
                    } else {
                        0.0
                    };
                }
                RecommendationKind::RadioAlbum => {
                    let seed_album_match = context.seed.as_ref().is_some_and(|s| {
                        (s.album_id.is_some() && s.album_id == track.album_id)
                            || s.album.as_deref() == Some(track.album_name.as_str())
                    });
                    score = if seed_album_match {
                        10.0
                    } else if matches_album {
                        4.0
                    } else {
                        0.0
                    };
                }
                RecommendationKind::RadioTrack | RecommendationKind::SimilarTracks => {
                    if context.seed.as_ref().is_some_and(|s| s.id == track.id) {
                        continue;
                    }
                    let same_artist = context.seed.as_ref().is_some_and(|s| {
                        (s.artist_id.is_some() && s.artist_id == track.artist_id)
                            || s.artist.as_deref() == Some(track.artist_name.as_str())
                    });
                    let same_album = context.seed.as_ref().is_some_and(|s| {
                        (s.album_id.is_some() && s.album_id == track.album_id)
                            || s.album.as_deref() == Some(track.album_name.as_str())
                    });
                    score = if same_artist {
                        8.0
                    } else if same_album {
                        6.0
                    } else if matches_artist {
                        3.0
                    } else {
                        1.0
                    };
                }
            }

            score += fb_weights.get(&track.id).copied().unwrap_or(0.0);
            if let Some(ref aid) = track.artist_id {
                score += fb_weights.get(aid).copied().unwrap_or(0.0) * 0.5;
            }
            if let Some(ref alid) = track.album_id {
                score += fb_weights.get(alid).copied().unwrap_or(0.0) * 0.25;
            }

            if score > -50.0 {
                candidates.push((avail, entry.cloned(), score));
            }
        }

        candidates.sort_by(|a, b| {
            b.2.partial_cmp(&a.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.item.title.cmp(&b.0.item.title))
        });

        let mut seen = crate::catalog::track_dedup::TrackDedup::default();
        candidates.retain(|(avail, _, _)| seen.insert_track(&avail.item));

        if context.kind == RecommendationKind::SimilarArtists {
            let mut seen_artists = HashSet::new();
            candidates.retain(|(avail, _, _)| {
                let key = avail
                    .item
                    .artist_id
                    .clone()
                    .unwrap_or_else(|| avail.item.artist_name.clone());
                seen_artists.insert(key)
            });
        }

        let mapped: Vec<UnifiedSearchResult> = candidates
            .into_iter()
            .map(|(avail, entry, _)| {
                let res = to_track_search_result(
                    &avail.item,
                    Some(avail.availability),
                    avail.sources,
                );
                with_reason(res, reason_for(context.kind, entry.as_ref()))
            })
            .collect();

        diversify_results(mapped, limit, 2, 2)
    }

    /// Generates radio tracks for a track, artist, or album seed.
    pub async fn radio(
        &self,
        catalog: &CatalogService,
        user_id: &str,
        seed: RecommendationSeed,
        limit: usize,
    ) -> Vec<UnifiedSearchResult> {
        if seed.seed_type == "track" {
            return self.autoplay(catalog, user_id, &seed.id, limit, &[]).await;
        }
        let kind = match seed.seed_type.as_str() {
            "artist" => RecommendationKind::RadioArtist,
            "album" => RecommendationKind::RadioAlbum,
            _ => RecommendationKind::RadioTrack,
        };
        self.recommend(
            catalog,
            &RecommendationContext {
                user_id: user_id.to_owned(),
                kind,
                limit,
                seed: Some(seed),
            },
        )
        .await
    }

    /// Builds multiple recommendation sections (`continue-listening`, `favorites-mix`,
    /// `forgotten-favorites`, `discover`, `similar-artists`) for `/api/recommendations`.
    pub async fn sections(
        &self,
        catalog: &CatalogService,
        user_id: &str,
        kinds: &[RecommendationKind],
        limit: usize,
    ) -> Vec<RecommendationSection> {
        let mut sections = Vec::new();
        for &kind in kinds {
            let items = self
                .recommend(
                    catalog,
                    &RecommendationContext {
                        user_id: user_id.to_owned(),
                        kind,
                        limit,
                        seed: None,
                    },
                )
                .await;
            if !items.is_empty() {
                sections.push(RecommendationSection {
                    id: kind,
                    title: kind.title().to_owned(),
                    items,
                });
            }
        }
        sections
    }
}

/// Computes a normalized recording key for playlist suggestions.
#[must_use]
pub fn playlist_recording_key(title: &str, artist: &str) -> String {
    let norm_artist = normalize_music_text(Some(artist));
    let norm_title = normalize_music_text(Some(title));
    format!("{norm_artist}:{norm_title}")
}

fn playlist_track_text<'a>(item: &'a Value, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| {
        item.get(name)?
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    })
}

fn playlist_track_isrc(item: &Value) -> Option<String> {
    item.pointer("/identityHints/isrc")
        .or_else(|| item.pointer("/metadata/isrc"))
        .and_then(Value::as_str)
        .filter(|isrc| !isrc.is_empty())
        .map(str::to_ascii_uppercase)
}

fn credited_artist_names(artist: &str) -> impl Iterator<Item = &str> {
    artist
        .split([';', '\u{0007}'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

#[derive(Default)]
pub(crate) struct PlaylistRecommendationSeeds {
    ids: HashSet<String>,
    recordings: HashSet<String>,
    isrcs: HashSet<String>,
    artists: HashMap<String, (String, usize)>,
    genres: HashSet<String>,
    moods: HashSet<String>,
}

impl PlaylistRecommendationSeeds {
    pub(crate) fn new(tracks: &[PlaylistTrack]) -> Self {
        let mut seeds = Self::default();
        for item in tracks {
            let track = &item.track;
            if let Some(id) = playlist_track_text(track, &["id"]) {
                seeds.ids.insert(id.to_owned());
            }
            let artist = playlist_track_text(track, &["artistName", "artist"]);
            if let (Some(title), Some(artist)) = (playlist_track_text(track, &["title"]), artist) {
                seeds
                    .recordings
                    .insert(playlist_recording_key(title, artist));
            }
            if let Some(isrc) = playlist_track_isrc(track) {
                seeds.isrcs.insert(isrc);
            }
            let credits = track
                .get("artistCredits")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|credit| playlist_track_text(credit, &["name"]));
            let mut counted = HashSet::new();
            for name in credits.chain(artist.into_iter().flat_map(credited_artist_names)) {
                let normalized = normalize_music_text(Some(name));
                if matches!(
                    normalized.as_str(),
                    "" | "unknown" | "unknown artist" | "various artists"
                ) || !counted.insert(normalized.clone())
                {
                    continue;
                }
                seeds
                    .artists
                    .entry(normalized)
                    .or_insert_with(|| (name.to_owned(), 0))
                    .1 += 1;
            }
            for (tag_set, field) in [(&mut seeds.genres, "genres"), (&mut seeds.moods, "moods")] {
                let tags = track
                    .get(field)
                    .and_then(Value::as_array)
                    .or_else(|| track.get("metadata")?.get(field)?.as_array());
                tag_set.extend(
                    tags.into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|tag| normalize_music_text(Some(tag)))
                        .filter(|tag| !tag.is_empty()),
                );
            }
        }
        seeds
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.artists.is_empty() && self.genres.is_empty() && self.moods.is_empty()
    }

    pub(crate) fn external_artist_names(&self) -> Vec<&str> {
        let mut artists: Vec<_> = self.artists.values().collect();
        artists.sort_by(|(a, count_a), (b, count_b)| count_b.cmp(count_a).then_with(|| a.cmp(b)));
        artists
            .into_iter()
            .take(3)
            .map(|(name, _)| name.as_str())
            .collect()
    }

    fn excludes(&self, id: &str, recording: &str, isrc: Option<&str>) -> bool {
        self.ids.contains(id)
            || self.recordings.contains(recording)
            || isrc.is_some_and(|code| self.isrcs.contains(code))
    }
}

pub(crate) async fn recommend_for_playlist(
    db: &DbPool,
    user_id: &str,
    seeds: &PlaylistRecommendationSeeds,
    inventory: &[Available<Track>],
    limit: usize,
) -> Vec<Value> {
    let filter = TasteProfileManager::new(db.clone())
        .feedback_filter(user_id, &[])
        .await;
    let mut candidates = Vec::new();
    for avail in inventory {
        if !avail.availability.library_available
            || avail.availability.state == AvailabilityState::Unavailable
        {
            continue;
        }
        let track = &avail.item;
        let recording = playlist_recording_key(&track.title, &track.artist_name);
        let isrc = track
            .identity_hints
            .as_ref()
            .and_then(|hints| hints.isrc.as_deref())
            .map(str::to_ascii_uppercase);
        if seeds.excludes(&track.id, &recording, isrc.as_deref())
            || !filter.allows(&TasteTarget::from_track(track))
        {
            continue;
        }

        let artist = normalize_music_text(Some(&track.artist_name));
        let same_artist = track
            .artist_credits
            .iter()
            .flatten()
            .map(|credit| credit.name.as_str())
            .chain(credited_artist_names(&track.artist_name))
            .find_map(|name| seeds.artists.get(&normalize_music_text(Some(name))));
        let shared_genre = track
            .genres
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|g| seeds.genres.contains(&normalize_music_text(Some(g))))
            .count();
        let shared_mood = track
            .moods
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|m| seeds.moods.contains(&normalize_music_text(Some(m))))
            .count();

        if same_artist.is_none() && shared_genre == 0 && shared_mood == 0 {
            continue;
        }

        let score = (i32::from(same_artist.is_some()) * 4)
            + (shared_genre.min(3) as i32 * 3)
            + (shared_mood.min(2) as i32 * 2);
        let reason = if let Some((name, _)) = same_artist {
            format!("{name} is in this playlist")
        } else {
            String::from("Shares genres or moods with this playlist")
        };
        if let Ok(Value::Object(mut item)) = serde_json::to_value(avail) {
            item.insert("recommendationReason".into(), Value::String(reason));
            candidates.push(PlaylistSuggestion {
                item: Value::Object(item),
                recording,
                isrc,
                artist,
                score,
            });
        }
    }

    pick_playlist_suggestions(candidates, limit)
}

pub(crate) async fn recommend_external_for_playlist<'a>(
    db: &DbPool,
    user_id: &str,
    seeds: &PlaylistRecommendationSeeds,
    inventory: &[Available<Track>],
    items: impl IntoIterator<Item = (Value, Option<&'a str>)>,
    limit: usize,
) -> Vec<Value> {
    let owned: HashSet<_> = inventory
        .iter()
        .map(|track| playlist_recording_key(&track.item.title, &track.item.artist_name))
        .collect();
    let owned_isrcs: HashSet<_> = inventory
        .iter()
        .filter_map(|track| {
            track
                .item
                .identity_hints
                .as_ref()?
                .isrc
                .as_deref()
                .map(str::to_ascii_uppercase)
        })
        .collect();
    let targets: Vec<_> = inventory
        .iter()
        .map(|track| TasteTarget::from_track(&track.item))
        .collect();
    let filter = TasteProfileManager::new(db.clone())
        .feedback_filter(user_id, &targets)
        .await;
    let mut candidates = Vec::new();
    for (mut item, related_to) in items {
        let (Some(id), Some(title), Some(artist_name)) = (
            playlist_track_text(&item, &["id"]),
            playlist_track_text(&item, &["title"]),
            playlist_track_text(&item, &["artistName", "artist"]),
        ) else {
            continue;
        };
        let artist = normalize_music_text(Some(artist_name));
        let (reason, score) = if seeds.artists.contains_key(&artist) {
            (format!("{artist_name} is in this playlist"), 2)
        } else if let Some(seed_artist) = related_to {
            (format!("Related to {seed_artist}"), 1)
        } else {
            continue;
        };
        let recording = playlist_recording_key(title, artist_name);
        let isrc = playlist_track_isrc(&item);
        if seeds.excludes(id, &recording, isrc.as_deref())
            || owned.contains(&recording)
            || isrc.as_ref().is_some_and(|code| owned_isrcs.contains(code))
        {
            continue;
        }
        let target = TasteTarget {
            id: id.to_owned(),
            item_type: Some("track".into()),
            title: Some(title.to_owned()),
            artist: Some(artist_name.to_owned()),
            album: playlist_track_text(&item, &["albumName", "album"]).map(str::to_owned),
            artist_id: playlist_track_text(&item, &["artistId"]).map(str::to_owned),
            album_id: playlist_track_text(&item, &["albumId"]).map(str::to_owned),
        };
        if !filter.allows(&target) {
            continue;
        }
        if let Some(fields) = item.as_object_mut() {
            fields.insert("recommendationReason".into(), Value::String(reason));
            candidates.push(PlaylistSuggestion {
                item,
                recording,
                isrc,
                artist,
                score,
            });
        }
    }
    pick_playlist_suggestions(candidates, limit)
}

struct PlaylistSuggestion {
    item: Value,
    recording: String,
    isrc: Option<String>,
    artist: String,
    score: i32,
}

fn pick_playlist_suggestions(mut candidates: Vec<PlaylistSuggestion>, limit: usize) -> Vec<Value> {
    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    let mut selected = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut seen_isrcs = HashSet::new();
    let mut per_artist: HashMap<String, usize> = HashMap::new();

    for cap in [1_usize, 2, usize::MAX] {
        for candidate in &candidates {
            let count = per_artist.entry(candidate.artist.clone()).or_default();
            if *count >= cap
                || seen_keys.contains(&candidate.recording)
                || candidate
                    .isrc
                    .as_ref()
                    .is_some_and(|code| seen_isrcs.contains(code))
            {
                continue;
            }
            *count += 1;
            seen_keys.insert(candidate.recording.clone());
            if let Some(code) = &candidate.isrc {
                seen_isrcs.insert(code.clone());
            }
            selected.push(candidate.item.clone());
            if selected.len() >= limit {
                return selected;
            }
        }
    }
    selected
}

/// Provider-neutral recommendation registry wrapping [`RecommendationService`].
#[derive(Clone)]
pub struct RecommendationRegistry {
    local: RecommendationService,
    custom_providers: Arc<RwLock<Vec<Arc<dyn RecommendationProvider>>>>,
}

impl std::fmt::Debug for RecommendationRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecommendationRegistry").finish()
    }
}

impl RecommendationRegistry {
    /// Creates a new [`RecommendationRegistry`].
    #[must_use]
    pub fn new(local: RecommendationService) -> Self {
        Self {
            local,
            custom_providers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Returns a reference to the built-in [`RecommendationService`].
    #[must_use]
    pub const fn local(&self) -> &RecommendationService {
        &self.local
    }

    /// Registers or replaces a custom [`RecommendationProvider`].
    pub fn register(&self, provider: Arc<dyn RecommendationProvider>) {
        if let Ok(mut guard) = self.custom_providers.write() {
            if let Some(pos) = guard.iter().position(|p| p.id() == provider.id()) {
                guard[pos] = provider;
            } else {
                guard.push(provider);
            }
        }
    }
}
