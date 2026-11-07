//! # Deezer Discovery Charts & Saved Discoveries Persistence (`external::discovery`)
//!
//! Complete Rust port of `server/src/domain/deezer-discovery.ts` and
//! `server/src/routes/saved-discoveries.ts`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::Row;
use url::Url;

use crate::db::{DbError, DbPool, create_id};
use crate::external::adapters::ExternalError;

/// Deezer editorial chart endpoint (`limit=14`).
pub const DEEZER_CHART_URL: &str = "https://api.deezer.com/chart?limit=14";

/// TTL (`10` minutes in milliseconds) for cached Deezer chart payloads.
pub const DEEZER_CHART_CACHE_MS: u64 = 10 * 60 * 1_000;

/// Normalized Deezer chart response (`ExternalCharts` in `deezer-discovery.ts`).
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalCharts {
    /// Charting artists.
    pub artists: Vec<Value>,
    /// Charting albums.
    pub albums: Vec<Value>,
    /// Charting tracks.
    pub tracks: Vec<Value>,
}

/// Normalizes a raw Deezer `/chart` JSON payload into [`ExternalCharts`], matching
/// `normalizeDeezerChart` in `server/src/domain/deezer-discovery.ts`.
pub fn normalize_deezer_chart(input: &Value) -> Result<ExternalCharts, ExternalError> {
    let invalid = |msg: &str| ExternalError::InvalidPayload {
        provider: "Deezer",
        message: msg.to_owned(),
    };

    let artists_arr = input
        .get("artists")
        .and_then(|a| a.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing artists.data array in Deezer chart"))?;

    let albums_arr = input
        .get("albums")
        .and_then(|a| a.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing albums.data array in Deezer chart"))?;

    let tracks_arr = input
        .get("tracks")
        .and_then(|t| t.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing tracks.data array in Deezer chart"))?;

    let mut artists = Vec::with_capacity(artists_arr.len());
    for item in artists_arr {
        let id = item
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("Invalid artist id"))?;
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Invalid artist name"))?;
        let cover = pick_https_cover(&[
            item.get("picture_xl").and_then(Value::as_str),
            item.get("picture_big").and_then(Value::as_str),
            item.get("picture_medium").and_then(Value::as_str),
        ]);

        artists.push(json!({
            "id": format!("external_deezer_artist_{id}"),
            "external": true,
            "provider": "deezer",
            "source": { "kind": "external", "count": 0 },
            "deezerUrl": item.get("link").and_then(Value::as_str),
            "coverArt": cover.map(|u| json!({ "url": u })),
            "type": "artist",
            "name": name,
        }));
    }

    let mut albums = Vec::with_capacity(albums_arr.len());
    for item in albums_arr {
        let id = item
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("Invalid album id"))?;
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Invalid album title"))?;
        let artist_name = item
            .get("artist")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist");
        let cover = pick_https_cover(&[
            item.get("cover_xl").and_then(Value::as_str),
            item.get("cover_big").and_then(Value::as_str),
            item.get("cover_medium").and_then(Value::as_str),
        ]);

        albums.push(json!({
            "id": format!("external_deezer_album_{id}"),
            "external": true,
            "provider": "deezer",
            "source": { "kind": "external", "count": 0 },
            "deezerUrl": item.get("link").and_then(Value::as_str),
            "coverArt": cover.map(|u| json!({ "url": u })),
            "type": "album",
            "title": title,
            "artist": artist_name,
        }));
    }

    let mut tracks = Vec::with_capacity(tracks_arr.len());
    for item in tracks_arr {
        let id = item
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("Invalid track id"))?;
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Invalid track title"))?;
        let duration = item
            .get("duration")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("Invalid track duration"))?;
        let artist_obj = item.get("artist");
        let artist_name = artist_obj
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown artist");
        let artist_id = artist_obj
            .and_then(|a| a.get("id"))
            .and_then(Value::as_i64)
            .map(|aid| format!("external_deezer_artist_{aid}"));

        let album_obj = item.get("album");
        let album_title = album_obj
            .and_then(|a| a.get("title"))
            .and_then(Value::as_str);
        let album_id = album_obj
            .and_then(|a| a.get("id"))
            .and_then(Value::as_i64)
            .map(|alid| format!("external_deezer_album_{alid}"));

        let cover = pick_https_cover(&[
            album_obj
                .and_then(|a| a.get("cover_xl"))
                .and_then(Value::as_str),
            album_obj
                .and_then(|a| a.get("cover_big"))
                .and_then(Value::as_str),
            album_obj
                .and_then(|a| a.get("cover_medium"))
                .and_then(Value::as_str),
        ]);
        let preview = item
            .get("preview")
            .or_else(|| item.get("preview_url"))
            .or_else(|| item.get("previewUrl"))
            .and_then(Value::as_str)
            .filter(|s| s.starts_with("https://"));
        let isrc = item
            .get("isrc")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        let duration_label = format!("{}:{:02}", duration / 60, duration % 60);

        tracks.push(json!({
            "id": format!("external_deezer_track_{id}"),
            "external": true,
            "provider": "deezer",
            "source": { "kind": "external", "count": 0 },
            "deezerUrl": item.get("link").and_then(Value::as_str),
            "coverArt": cover.map(|u| json!({ "url": u })),
            "coverUrl": cover,
            "type": "track",
            "title": title,
            "artist": artist_name,
            "album": album_title,
            "previewUrl": preview,
            "isrc": isrc,
            "duration": duration,
            "durationLabel": duration_label,
            "metadata": {
                "durationSeconds": duration,
                "artistId": artist_id,
                "albumId": album_id,
                "isrc": isrc,
            }
        }));
    }

    Ok(ExternalCharts {
        artists,
        albums,
        tracks,
    })
}

fn pick_https_cover<'a>(candidates: &[Option<&'a str>]) -> Option<&'a str> {
    candidates
        .iter()
        .flatten()
        .copied()
        .find(|u| u.starts_with("https://"))
}

/// Service fetching and caching Deezer editorial charts with stale-if-error fallback.
#[derive(Debug, Clone)]
pub struct DeezerDiscoveryService {
    http: reqwest::Client,
    cache: Arc<Mutex<Option<(u64, ExternalCharts)>>>,
}

impl Default for DeezerDiscoveryService {
    fn default() -> Self {
        Self::new()
    }
}

impl DeezerDiscoveryService {
    /// Creates a new [`DeezerDiscoveryService`].
    #[must_use]
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(8_000))
            .build()
            .unwrap_or_default();
        Self {
            http,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Fetches Deezer charts, serving the 10-minute cached copy when fresh or falling back
    /// to a stale cached copy if an upstream outage occurs.
    pub async fn get_charts(&self) -> Result<ExternalCharts, ExternalError> {
        let now_ms = current_epoch_ms();
        let stale_fallback = {
            let guard = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((expires_at, ref charts)) = *guard {
                if now_ms < expires_at {
                    return Ok(charts.clone());
                }
                Some(charts.clone())
            } else {
                None
            }
        };

        let res = self
            .http
            .get(DEEZER_CHART_URL)
            .header("Accept", "application/json")
            .send()
            .await;

        let response = match res {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                if let Some(stale) = stale_fallback {
                    return Ok(stale);
                }
                return Err(ExternalError::Upstream {
                    provider: "Deezer",
                    message: format!("Deezer chart request failed ({})", r.status().as_u16()),
                });
            }
            Err(err) => {
                if let Some(stale) = stale_fallback {
                    return Ok(stale);
                }
                return Err(ExternalError::Upstream {
                    provider: "Deezer",
                    message: err.to_string(),
                });
            }
        };

        let raw_json: Value = response.json().await.map_err(|_| ExternalError::InvalidPayload {
            provider: "Deezer",
            message: String::from("Invalid Deezer chart JSON"),
        })?;

        let charts = normalize_deezer_chart(&raw_json)?;
        if let Ok(mut guard) = self.cache.lock() {
            *guard = Some((now_ms + DEEZER_CHART_CACHE_MS, charts.clone()));
        }
        Ok(charts)
    }
}

// ============================================================================
// Saved External Discoveries (`server/src/routes/saved-discoveries.ts`)
// ============================================================================

/// Input payload for `POST /api/v1/discoveries/save` (`saveSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDiscoveryInput {
    /// External provider (`"deezer"` or `"itunes"`).
    pub provider: String,
    /// Provider-native or prefixed external ID.
    pub external_id: String,
    /// Entity type (`"track"` or `"album"`).
    #[serde(rename = "type")]
    pub item_type: String,
    /// Track or album title (`1..=300` trimmed chars).
    pub title: String,
    /// Artist name (`1..=300` trimmed chars).
    pub artist: String,
    /// Optional cover artwork URL (`/api/...` or `http(s)://...`).
    #[serde(default)]
    pub cover_url: Option<String>,
    /// Optional metadata map (`isrc`, `songCount`, `trackCount`, etc.).
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

/// Persisted discovery bookmark returned by `/api/v1/discoveries/*`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedDiscoveryRecord {
    /// Bookmark ID (`discovery_<nanoid>`).
    pub id: String,
    /// Provider (`"deezer"` or `"itunes"`).
    pub provider: String,
    /// Canonicalized external ID (stripped of `external_<provider>_<type>_` prefix).
    pub external_id: String,
    /// Entity type (`"track"` or `"album"`).
    #[serde(rename = "type")]
    pub item_type: String,
    /// Title.
    pub title: String,
    /// Artist.
    pub artist: String,
    /// Cover URL.
    pub cover_url: Option<String>,
    /// Parsed metadata object.
    pub metadata: Map<String, Value>,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// Annotated on `GET /api/v1/discoveries/saved`.
    #[serde(skip_serializing_if = "Option::is_none", rename = "inLibrary")]
    pub in_library: Option<bool>,
    /// Acquisition status (`IDLE`, `QUEUED`, `IMPORTING`, `FAILED`, `UNKNOWN`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Last acquisition error message, if failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Validates and saves a discovery bookmark in `saved_discoveries`, returning `(created_new, record)`.
pub async fn save_discovery(
    pool: &DbPool,
    user_id: &str,
    mut input: SaveDiscoveryInput,
) -> Result<(bool, SavedDiscoveryRecord), String> {
    if !matches!(input.provider.as_str(), "deezer" | "itunes")
        || !matches!(input.item_type.as_str(), "track" | "album")
    {
        return Err(String::from("Invalid saved discovery"));
    }

    input.title = input.title.trim().to_owned();
    input.artist = input.artist.trim().to_owned();
    if input.title.is_empty()
        || input.title.chars().count() > 300
        || input.artist.is_empty()
        || input.artist.chars().count() > 300
    {
        return Err(String::from("Invalid saved discovery"));
    }

    if let Some(ref cov) = input.cover_url {
        if cov.len() > 2048 || !is_valid_discovery_cover_url(cov) {
            return Err(String::from("Invalid saved discovery"));
        }
    }

    let prefix = format!("external_{}_{}_", input.provider, input.item_type);
    let raw_ext = input.external_id.trim();
    let canonical_ext = raw_ext.strip_prefix(&prefix).unwrap_or(raw_ext).trim();
    if canonical_ext.is_empty() || canonical_ext.len() > 200 {
        return Err(String::from("External ID is required"));
    }

    let id = create_id("discovery");
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let metadata_json = serde_json::to_string(&input.metadata).unwrap_or_else(|_| String::from("{}"));

    let insert_res = sqlx::query(
        r"
        INSERT INTO saved_discoveries
          (id, user_id, provider, external_id, type, title, artist, cover_url, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider, type, external_id) DO NOTHING;
        ",
    )
    .bind(&id)
    .bind(user_id)
    .bind(&input.provider)
    .bind(canonical_ext)
    .bind(&input.item_type)
    .bind(&input.title)
    .bind(&input.artist)
    .bind(&input.cover_url)
    .bind(&metadata_json)
    .bind(&now_iso)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    let row = sqlx::query(
        r"
        SELECT * FROM saved_discoveries
        WHERE user_id = ? AND provider = ? AND type = ? AND external_id = ?;
        ",
    )
    .bind(user_id)
    .bind(&input.provider)
    .bind(&input.item_type)
    .bind(canonical_ext)
    .fetch_one(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    let record = map_saved_row(&row).map_err(|e| e.to_string())?;
    Ok((insert_res.rows_affected() > 0, record))
}

/// Deletes a saved discovery bookmark owned by `user_id`.
pub async fn delete_saved_discovery(
    pool: &DbPool,
    user_id: &str,
    id: &str,
) -> Result<bool, DbError> {
    let res = sqlx::query("DELETE FROM saved_discoveries WHERE id = ? AND user_id = ?;")
        .bind(id)
        .bind(user_id)
        .execute(pool.inner())
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Lists saved discoveries for `user_id`, cross-referencing `acquisition_jobs` to annotate
/// `status` (`IDLE`, `QUEUED`, `IMPORTING`, `FAILED`) and auto-pruning completed imports.
pub async fn list_saved_discoveries(
    pool: &DbPool,
    user_id: &str,
) -> Result<Vec<SavedDiscoveryRecord>, DbError> {
    let rows = sqlx::query(
        "SELECT * FROM saved_discoveries WHERE user_id = ? ORDER BY created_at DESC, id ASC;",
    )
    .bind(user_id)
    .fetch_all(pool.inner())
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    let mut completed_ids = Vec::new();

    for row in rows {
        let mut item = map_saved_row(&row)?;
        let external_key = format!(
            "external_{}_{}_{}",
            item.provider, item.item_type, item.external_id
        );

        let job_row = sqlx::query(
            r"
            SELECT status, error_message, updated_at
            FROM acquisition_jobs
            WHERE user_id = ?
              AND (
                (? = 'track' AND requested_track_id = ?)
                OR (? = 'album' AND requested_album_id = ? AND requested_track_id IS NULL)
              )
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1;
            ",
        )
        .bind(user_id)
        .bind(&item.item_type)
        .bind(&external_key)
        .bind(&item.item_type)
        .bind(&external_key)
        .fetch_optional(pool.inner())
        .await?;

        if let Some(job) = job_row {
            let status_str: String = job.try_get("status")?;
            let err_msg: Option<String> = job.try_get("error_message")?;
            let job_updated: String = job.try_get("updated_at")?;

            if status_str == "completed" && job_updated >= item.created_at {
                completed_ids.push(item.id);
                continue;
            }

            let mapped_status = match status_str.as_str() {
                "queued" => "QUEUED",
                "discovering" | "downloading" | "processing" | "importing" => "IMPORTING",
                "failed" => "FAILED",
                _ => "IDLE",
            };
            item.in_library = Some(false);
            item.status = Some(String::from(mapped_status));
            item.error = err_msg;
        } else {
            item.in_library = Some(false);
            item.status = Some(String::from("IDLE"));
            item.error = None;
        }

        out.push(item);
    }

    for id in completed_ids {
        let _ = sqlx::query("DELETE FROM saved_discoveries WHERE id = ? AND user_id = ?;")
            .bind(id)
            .bind(user_id)
            .execute(pool.inner())
            .await;
    }

    Ok(out)
}

fn map_saved_row(row: &sqlx::sqlite::SqliteRow) -> Result<SavedDiscoveryRecord, DbError> {
    let meta_str: String = row.try_get("metadata_json")?;
    let metadata = serde_json::from_str::<Map<String, Value>>(&meta_str).unwrap_or_default();

    Ok(SavedDiscoveryRecord {
        id: row.try_get("id")?,
        provider: row.try_get("provider")?,
        external_id: row.try_get("external_id")?,
        item_type: row.try_get("type")?,
        title: row.try_get("title")?,
        artist: row.try_get("artist")?,
        cover_url: row.try_get("cover_url")?,
        metadata,
        created_at: row.try_get("created_at")?,
        in_library: None,
        status: None,
        error: None,
    })
}

fn is_valid_discovery_cover_url(value: &str) -> bool {
    if value.starts_with("/api/") && !value.contains('\\') {
        return true;
    }
    Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
