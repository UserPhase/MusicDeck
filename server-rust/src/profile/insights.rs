//! # Library Insights, Health Auditing & Collection Analytics (`profile::insights`)
//!
//! Ports `server/src/domain/library-insights.ts` and `server/src/domain/library-health.ts`:
//! - [`LibraryHealthIssueType`], [`LibraryHealthIssue`], [`LibraryHealthCounts`], [`audit_catalog`], [`count_issues`]
//! - [`LibraryInsightsService`]:
//!   - `set_favorite`: Upserts/deletes `media_favorites`
//!   - `tracks` & `collector_tracks`: Decorates catalog tracks with `favorite`, `playCount`,
//!     `played`, `lastPlayedAt`, `libraryState`, and `externalState`
//!   - `health`: Audits tracks and albums for missing artwork, missing metadata, duplicates,
//!     unavailable items, and incomplete albums
//!   - `statistics`: Computes total duration, played %, favorite %, year distribution, and top-20 artist distribution
//!   - `save_filter`, `list_filters`, and `collection`

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::catalog::{AvailabilityState, Available, CatalogService, derive_canonical_identity};
use crate::db::DbPool;
use crate::providers::{Album, Track};
use crate::search::to_track_search_result;

/// Classification of a catalog health issue (`library-health.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LibraryHealthIssueType {
    MissingArtwork,
    MissingMetadata,
    MissingArtist,
    MissingAlbum,
    DuplicateTrack,
    DuplicateAlbum,
    Unavailable,
    IncompleteAlbum,
    AlbumNotListed,
    OrphanedTrack,
}

/// Individual health issue detected during [`audit_catalog`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthIssue {
    #[serde(rename = "type")]
    pub issue_type: LibraryHealthIssueType,
    pub item_type: String,
    pub item_id: String,
    pub title: String,
    pub detail: String,
}

/// Aggregated counts of [`LibraryHealthIssue`] items by category.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealthCounts {
    pub missing_artwork: usize,
    pub metadata_issues: usize,
    pub duplicates: usize,
    pub unavailable: usize,
    pub incomplete_albums: usize,
    pub sync_mismatches: usize,
    pub orphaned_tracks: usize,
}

/// Audits `tracks` and `albums` for missing artwork/metadata, canonical identity duplicates,
/// unavailable sources, and incomplete albums (`server/src/domain/library-health.ts`).
#[must_use]
pub fn audit_catalog(
    tracks: &[Available<Track>],
    albums: &[Available<Album>],
    albums_complete: bool,
) -> Vec<LibraryHealthIssue> {
    let mut issues = Vec::new();
    let mut track_counts_by_album: HashMap<String, u32> = HashMap::new();
    let album_ids: HashSet<&str> = albums.iter().map(|a| a.item.id.as_str()).collect();

    for t in tracks {
        let track = &t.item;
        if track.artwork_id.as_deref().is_none_or(str::is_empty) {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingArtwork,
                item_type: String::from("track"),
                item_id: track.id.clone(),
                title: track.title.clone(),
                detail: String::from("Missing artwork"),
            });
        }
        if track.title.trim().is_empty() {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingMetadata,
                item_type: String::from("track"),
                item_id: track.id.clone(),
                title: String::from("Untitled"),
                detail: String::from("Missing title"),
            });
        }
        if track.artist_id.as_deref().is_none_or(str::is_empty)
            || track.artist_name.trim().is_empty()
        {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingArtist,
                item_type: String::from("track"),
                item_id: track.id.clone(),
                title: track.title.clone(),
                detail: String::from("Missing artist"),
            });
        }
        if track.album_id.as_deref().is_none_or(str::is_empty)
            || track.album_name.trim().is_empty()
        {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingAlbum,
                item_type: String::from("track"),
                item_id: track.id.clone(),
                title: track.title.clone(),
                detail: String::from("Missing album"),
            });
        }
        if t.availability.state == AvailabilityState::Unavailable {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::Unavailable,
                item_type: String::from("track"),
                item_id: track.id.clone(),
                title: track.title.clone(),
                detail: String::from("Unavailable"),
            });
        }
        if let Some(album_id) = track.album_id.as_deref().filter(|s| !s.is_empty()) {
            if albums_complete && !album_ids.contains(album_id) {
                issues.push(LibraryHealthIssue {
                    issue_type: LibraryHealthIssueType::AlbumNotListed,
                    item_type: String::from("track"),
                    item_id: track.id.clone(),
                    title: track.title.clone(),
                    detail: format!(
                        "Album \"{}\" is missing from the server's album list",
                        if track.album_name.is_empty() {
                            "Unknown"
                        } else {
                            &track.album_name
                        }
                    ),
                });
            }
            *track_counts_by_album.entry(album_id.to_owned()).or_insert(0) += 1;
        }
    }

    let mut groups: HashMap<String, Vec<&Available<Track>>> = HashMap::new();
    for t in tracks {
        let search_res = to_track_search_result(
            &t.item,
            Some(t.availability.clone()),
            t.sources.clone(),
        );
        let ident = derive_canonical_identity(&search_res.to_catalog_item());
        groups.entry(ident.id).or_default().push(t);
    }

    for group in groups.values() {
        if group.len() < 2 {
            continue;
        }
        for t in group {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::DuplicateTrack,
                item_type: String::from("track"),
                item_id: t.item.id.clone(),
                title: t.item.title.clone(),
                detail: String::from("Possible duplicate"),
            });
        }
    }

    for a in albums {
        let album = &a.item;
        if album.artwork_id.as_deref().is_none_or(str::is_empty) {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingArtwork,
                item_type: String::from("album"),
                item_id: album.id.clone(),
                title: album.name.clone(),
                detail: String::from("Missing artwork"),
            });
        }
        if album.artist_id.as_deref().is_none_or(str::is_empty)
            || album.artist_name.trim().is_empty()
        {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::MissingArtist,
                item_type: String::from("album"),
                item_id: album.id.clone(),
                title: album.name.clone(),
                detail: String::from("Missing artist"),
            });
        }
        if a.availability.state == AvailabilityState::Unavailable {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::Unavailable,
                item_type: String::from("album"),
                item_id: album.id.clone(),
                title: album.name.clone(),
                detail: String::from("Unavailable"),
            });
        }
        let found_tracks = track_counts_by_album.get(&album.id).copied().unwrap_or(0);
        let expected_tracks = album.song_count;
        if expected_tracks > 0 && found_tracks > 0 && found_tracks < expected_tracks {
            issues.push(LibraryHealthIssue {
                issue_type: LibraryHealthIssueType::IncompleteAlbum,
                item_type: String::from("album"),
                item_id: album.id.clone(),
                title: album.name.clone(),
                detail: format!("{found_tracks} / {expected_tracks} tracks available"),
            });
        }
    }

    issues
}

/// Counts [`LibraryHealthIssue`] items by category.
#[must_use]
pub fn count_issues(issues: &[LibraryHealthIssue]) -> LibraryHealthCounts {
    let mut counts = LibraryHealthCounts::default();
    for issue in issues {
        match issue.issue_type {
            LibraryHealthIssueType::MissingArtwork => counts.missing_artwork += 1,
            LibraryHealthIssueType::MissingMetadata
            | LibraryHealthIssueType::MissingArtist
            | LibraryHealthIssueType::MissingAlbum => counts.metadata_issues += 1,
            LibraryHealthIssueType::DuplicateTrack | LibraryHealthIssueType::DuplicateAlbum => {
                counts.duplicates += 1;
            }
            LibraryHealthIssueType::Unavailable => counts.unavailable += 1,
            LibraryHealthIssueType::OrphanedTrack => counts.orphaned_tracks += 1,
            LibraryHealthIssueType::IncompleteAlbum => {
                counts.incomplete_albums += 1;
                counts.sync_mismatches += 1;
            }
            LibraryHealthIssueType::AlbumNotListed => {
                counts.sync_mismatches += 1;
            }
        }
    }
    counts
}

/// Filter predicate used by [`LibraryInsightsService`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilter {
    pub field: String,
    #[serde(default)]
    pub op: Option<String>,
    pub value: Value,
}

/// Saved filter record stored in `saved_filters`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLibraryFilter {
    pub id: String,
    pub name: String,
    pub filters: Vec<LibraryFilter>,
}

/// Collection-wide listening & catalog insight metrics returned by `GET /api/library/insights/statistics`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInsight {
    pub tracks: usize,
    pub albums: usize,
    pub artists: usize,
    pub total_duration_seconds: u64,
    pub played_percentage: u32,
    pub favorite_percentage: u32,
    pub year_distribution: BTreeMap<i32, usize>,
    pub artist_distribution: Vec<(String, usize)>,
}

/// Service computing deep library analytics, health audits, and user track annotations.
#[derive(Clone)]
pub struct LibraryInsightsService {
    db: DbPool,
    catalog: CatalogService,
}

impl LibraryInsightsService {
    /// Creates a new [`LibraryInsightsService`].
    #[must_use]
    pub const fn new(db: DbPool, catalog: CatalogService) -> Self {
        Self { db, catalog }
    }

    async fn load_user_annotations(
        &self,
        user_id: &str,
    ) -> (HashSet<String>, HashMap<String, (i64, String)>) {
        let mut favs = HashSet::new();
        if let Ok(rows) = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(self.db.inner())
            .await
        {
            for r in rows {
                if let Ok(id) = r.try_get::<String, _>("track_id") {
                    favs.insert(format!("track:{id}"));
                }
            }
        }
        if let Ok(rows) = sqlx::query(
            "SELECT item_type, item_id FROM media_favorites WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        {
            for r in rows {
                if let (Ok(t), Ok(id)) = (
                    r.try_get::<String, _>("item_type"),
                    r.try_get::<String, _>("item_id"),
                ) {
                    favs.insert(format!("{t}:{id}"));
                }
            }
        }

        let mut plays = HashMap::new();
        if let Ok(rows) = sqlx::query(
            r"
            SELECT track_id, COUNT(*) AS play_count, MAX(played_at) AS last_played_at
            FROM recently_played
            WHERE user_id = ?
            GROUP BY track_id
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        {
            for r in rows {
                if let Ok(id) = r.try_get::<String, _>("track_id") {
                    let count: i64 = r.try_get("play_count").unwrap_or(0);
                    let last: String = r.try_get("last_played_at").unwrap_or_default();
                    plays.insert(id, (count, last));
                }
            }
        }

        (favs, plays)
    }

    /// Sets or removes a favorite in `media_favorites`.
    pub async fn set_favorite(
        &self,
        user_id: &str,
        item_type: &str,
        item_id: &str,
        favorite: bool,
        metadata: Option<&Value>,
    ) {
        if favorite {
            let now = Utc::now().to_rfc3339();
            let meta_str = metadata.and_then(|m| serde_json::to_string(m).ok());
            let _ = sqlx::query(
                r"
                INSERT INTO media_favorites (user_id, item_type, item_id, created_at, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
                    metadata_json = COALESCE(excluded.metadata_json, media_favorites.metadata_json)
                ",
            )
            .bind(user_id)
            .bind(item_type)
            .bind(item_id)
            .bind(now)
            .bind(meta_str)
            .execute(self.db.inner())
            .await;
        } else {
            let _ = sqlx::query(
                "DELETE FROM media_favorites WHERE user_id = ? AND item_type = ? AND item_id = ?",
            )
            .bind(user_id)
            .bind(item_type)
            .bind(item_id)
            .execute(self.db.inner())
            .await;
        }
    }

    /// Runs a catalog health audit and returns a 200-issue capped summary.
    pub async fn health(&self) -> Value {
        let (tracks_res, albums_res, artists_res) = tokio::join!(
            self.catalog.list_tracks(),
            self.catalog.list_albums(Some(1000)),
            self.catalog.list_artists()
        );
        let albums_res = albums_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });
        let artists_res = artists_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });

        let issues = audit_catalog(&tracks_res.items, &albums_res.items, false);
        let counts = count_issues(&issues);
        let capped: Vec<LibraryHealthIssue> = issues.into_iter().take(200).collect();

        json!({
            "summary": {
                "albums": albums_res.items.len(),
                "tracks": tracks_res.items.len(),
                "artists": artists_res.items.len(),
                "missingArtwork": counts.missing_artwork,
                "metadataIssues": counts.metadata_issues,
                "duplicates": counts.duplicates,
                "unavailable": counts.unavailable,
                "incompleteAlbums": counts.incomplete_albums,
            },
            "issues": capped,
            "degraded": tracks_res.degraded || albums_res.degraded || artists_res.degraded,
        })
    }

    /// Computes collection statistics (`LibraryInsight`) for `user_id`.
    pub async fn statistics(&self, user_id: &str) -> Value {
        let (tracks_res, albums_res, artists_res, (favs, plays)) = tokio::join!(
            self.catalog.list_tracks(),
            self.catalog.list_albums(Some(1000)),
            self.catalog.list_artists(),
            self.load_user_annotations(user_id)
        );
        let albums_res = albums_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });
        let artists_res = artists_res.unwrap_or(crate::catalog::CatalogListResult {
            items: Vec::new(),
            degraded: true,
        });

        let total_tracks = tracks_res.items.len();
        let mut total_duration = 0_u64;
        let mut played_count = 0_usize;
        let mut favorite_count = 0_usize;
        let mut years: BTreeMap<i32, usize> = BTreeMap::new();
        let mut by_artist: HashMap<String, usize> = HashMap::new();

        for album in &albums_res.items {
            if let Some(year) = album.item.year {
                *years.entry(year).or_insert(0) += 1;
            }
        }

        for t in &tracks_res.items {
            total_duration += u64::from(t.item.duration_seconds.unwrap_or(0));
            if plays.contains_key(&t.item.id) {
                played_count += 1;
            }
            if favs.contains(&format!("track:{}", t.item.id)) {
                favorite_count += 1;
            }
            *by_artist.entry(t.item.artist_name.clone()).or_insert(0) += 1;
        }

        let mut top_artists: Vec<(String, usize)> = by_artist.into_iter().collect();
        top_artists.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top_artists.truncate(20);

        let artist_dist_map: serde_json::Map<String, Value> = top_artists
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect();

        let year_dist_map: serde_json::Map<String, Value> = years
            .into_iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect();

        let played_pct = if total_tracks > 0 {
            ((played_count as f64 / total_tracks as f64) * 100.0).round() as u32
        } else {
            0
        };
        let fav_pct = if total_tracks > 0 {
            ((favorite_count as f64 / total_tracks as f64) * 100.0).round() as u32
        } else {
            0
        };

        json!({
            "collection": {
                "tracks": total_tracks,
                "albums": albums_res.items.len(),
                "artists": artists_res.items.len(),
                "totalDurationSeconds": total_duration,
                "playedPercentage": played_pct,
                "favoritePercentage": fav_pct,
                "yearDistribution": year_dist_map,
                "artistDistribution": artist_dist_map,
            },
            "degraded": tracks_res.degraded || albums_res.degraded || artists_res.degraded,
        })
    }

    /// Saves a named filter set in `saved_filters`.
    pub async fn save_filter(
        &self,
        user_id: &str,
        name: &str,
        filters: Vec<LibraryFilter>,
    ) -> SavedLibraryFilter {
        let id = format!("filter_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();
        let filters_json =
            serde_json::to_string(&filters).unwrap_or_else(|_| String::from("[]"));

        let _ = sqlx::query(
            r"
            INSERT INTO saved_filters (id, user_id, name, filters_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(&id)
        .bind(user_id)
        .bind(name)
        .bind(filters_json)
        .bind(&now)
        .bind(&now)
        .execute(self.db.inner())
        .await;

        SavedLibraryFilter {
            id,
            name: name.to_owned(),
            filters,
        }
    }

    /// Lists saved filter sets for `user_id`.
    pub async fn list_filters(&self, user_id: &str) -> Vec<SavedLibraryFilter> {
        let rows = sqlx::query(
            "SELECT id, name, filters_json FROM saved_filters WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        .unwrap_or_default();

        rows.into_iter()
            .filter_map(|r| {
                let id: String = r.try_get("id").ok()?;
                let name: String = r.try_get("name").ok()?;
                let raw: String = r.try_get("filters_json").unwrap_or_default();
                let filters =
                    serde_json::from_str::<Vec<LibraryFilter>>(&raw).unwrap_or_default();
                Some(SavedLibraryFilter { id, name, filters })
            })
            .collect()
    }
}
