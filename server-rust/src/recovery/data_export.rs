//! # GDPR-Compliant User Data Export Pipeline (`recovery::data_export`)
//!
//! Ports `server/src/services/DataExportService.ts`:
//! - [`EXPORT_PAGE_SIZE`] (`500` rows per bounded keyset-paginated `rowid` query)
//! - [`PlaylistExportFormat`] (`m3u8 | xspf`) and [`ExportKind`] (`playlists | history | favorites | settings | bundle`)
//! - [`xml_text`]: Strips illegal XML 1.0 control characters and escapes `&`, `<`, `>`, `"`, `'`
//! - [`csv_cell`]: RFC 4180 quoting with spreadsheet formula-injection protection
//!   (prefixing leading `=`, `+`, `-`, `@`, `\t`, `\r`, `\n` cells with `'`)
//! - [`DataExportService`]:
//!   - `summary`: Computes counts and estimated byte sizes across `playlists`, `playlist_items`,
//!     `listening_events`, `favorites`, `media_favorites`, `recommendation_feedback`,
//!     `media_ratings`, `user_settings`, `smart_playlists`, and `saved_discoveries`
//!   - `export_playlist_text` (`m3u8` / `xspf`), `export_history_csv`, `export_favorites_json`,
//!     `export_settings_json`, and `export_bundle_json`

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::db::DbPool;
use crate::domain::settings::ALLOWED_USER_SETTINGS;

/// Bounded page size for `rowid`-paginated export queries (`500`).
pub const EXPORT_PAGE_SIZE: i64 = 500;

/// Playlist export file format (`m3u8 | xspf`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistExportFormat {
    M3u8,
    Xspf,
}

impl PlaylistExportFormat {
    /// Parses `"m3u8"` or `"xspf"`.
    #[must_use]
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.unwrap_or("m3u8").trim().to_ascii_lowercase().as_str() {
            "m3u8" => Some(Self::M3u8),
            "xspf" => Some(Self::Xspf),
            _ => None,
        }
    }
}

/// User data export category (`playlists | history | favorites | settings | bundle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Playlists,
    History,
    Favorites,
    Settings,
    Bundle,
}

/// Estimated byte sizes for a single playlist in [`ExportSummary`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEstimatedBytes {
    pub m3u8: usize,
    pub xspf: usize,
}

/// Playlist entry inside [`ExportSummary::playlists`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlaylistSummary {
    pub id: String,
    pub name: String,
    pub tracks: usize,
    pub estimated_bytes: PlaylistEstimatedBytes,
}

/// Record counts inside [`ExportSummary::counts`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCounts {
    pub playlists: usize,
    pub playlist_tracks: usize,
    pub history: usize,
    pub favorites: usize,
    pub feedback: usize,
    pub ratings: usize,
    pub settings: usize,
    pub smart_playlists: usize,
    pub saved_discoveries: usize,
}

/// Overall estimated download sizes inside [`ExportSummary::estimated_bytes`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEstimatedBytes {
    pub history: usize,
    pub favorites: usize,
    pub settings: usize,
    pub json: usize,
    pub zip: usize,
}

/// Pre-export inventory and size summary returned by `GET /api/v1/user/export/summary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub generated_at: String,
    pub playlists: Vec<ExportPlaylistSummary>,
    pub counts: ExportCounts,
    pub estimated_bytes: ExportEstimatedBytes,
    pub notes: Vec<String>,
}

/// Error returned when a requested export playlist or user does not exist.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ExportNotFoundError(pub String);

fn sanitize_single_line(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c <= '\u{001F}' || c == '\u{007F}' {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// Strips illegal XML 1.0 control characters and escapes `&`, `<`, `>`, `"`, and `'`.
#[must_use]
pub fn xml_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        let code = ch as u32;
        if matches!(code, 0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F | 0xFFFE | 0xFFFF) {
            continue;
        }
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Formats a value as an RFC 4180 CSV cell with spreadsheet formula-injection protection.
#[must_use]
pub fn csv_cell(value: &str) -> String {
    let starts_with_tab_or_newline = value.starts_with(['\t', '\r', '\n']);
    let first_non_ctrl = value
        .chars()
        .find(|&c| !c.is_whitespace() && c > '\u{001F}');
    let formula_prefix = matches!(first_non_ctrl, Some('=' | '+' | '-' | '@'));

    let sanitized = if starts_with_tab_or_newline || formula_prefix {
        format!("'{value}")
    } else {
        value.to_owned()
    };

    format!("\"{}\"", sanitized.replace('"', "\"\""))
}

/// Service generating portable user data exports (`m3u8`, `xspf`, `csv`, `json`).
#[derive(Debug, Clone)]
pub struct DataExportService {
    db: Option<DbPool>,
    public_url: String,
}

impl DataExportService {
    /// Creates a new [`DataExportService`].
    #[must_use]
    pub fn new(db: Option<DbPool>, public_url: impl Into<String>) -> Self {
        let mut url = public_url.into();
        if !url.ends_with('/') {
            url.push('/');
        }
        Self {
            db,
            public_url: url,
        }
    }

    async fn count_user_table(&self, pool: &DbPool, table: &str, user_id: &str) -> usize {
        let sql = format!("SELECT COUNT(*) AS total FROM {table} WHERE user_id = ?");
        sqlx::query(&sql)
            .bind(user_id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i64, _>("total").ok())
            .unwrap_or(0)
            .max(0) as usize
    }

    /// Computes the [`ExportSummary`] for `user_id`.
    pub async fn summary(&self, user_id: &str) -> ExportSummary {
        let mut playlists = Vec::new();
        let mut counts = ExportCounts::default();

        if let Some(pool) = &self.db {
            let pl_rows = sqlx::query(
                r"
                SELECT p.id, p.name, COUNT(i.id) AS tracks
                FROM playlists p
                LEFT JOIN playlist_items i ON i.playlist_id = p.id
                WHERE p.deleted_at IS NULL
                  AND (p.owner_user_id = ? OR p.owner_user_id IS NULL)
                GROUP BY p.id
                ORDER BY p.name, p.id
                ",
            )
            .bind(user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

            for r in pl_rows {
                let id: String = r.try_get("id").unwrap_or_default();
                let name: String = r.try_get("name").unwrap_or_default();
                let tracks = r.try_get::<i64, _>("tracks").unwrap_or(0).max(0) as usize;
                counts.playlist_tracks += tracks;
                playlists.push(ExportPlaylistSummary {
                    id,
                    name,
                    tracks,
                    estimated_bytes: PlaylistEstimatedBytes {
                        m3u8: 100 + tracks * 320,
                        xspf: 250 + tracks * 600,
                    },
                });
            }
            counts.playlists = playlists.len();

            counts.history = self
                .count_user_table(pool, "listening_events", user_id)
                .await;
            counts.feedback = self
                .count_user_table(pool, "recommendation_feedback", user_id)
                .await;
            counts.ratings = self
                .count_user_table(pool, "media_ratings", user_id)
                .await;
            counts.smart_playlists = self
                .count_user_table(pool, "smart_playlists", user_id)
                .await;
            counts.saved_discoveries = self
                .count_user_table(pool, "saved_discoveries", user_id)
                .await;

            let fav_count: usize = sqlx::query(
                r"
                SELECT COUNT(*) AS total FROM (
                    SELECT 'track', track_id FROM favorites WHERE user_id = ?
                    UNION
                    SELECT item_type, item_id FROM media_favorites WHERE user_id = ?
                )
                ",
            )
            .bind(user_id)
            .bind(user_id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i64, _>("total").ok())
            .unwrap_or(0)
            .max(0) as usize;
            counts.favorites = fav_count;

            let setting_rows = sqlx::query("SELECT key FROM user_settings WHERE user_id = ?")
                .bind(user_id)
                .fetch_all(pool.inner())
                .await
                .unwrap_or_default();
            counts.settings = setting_rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("key").ok())
                .filter(|k| ALLOWED_USER_SETTINGS.contains(&k.as_str()))
                .count();
        }

        let history_bytes = 110 + counts.history * 240;
        let fav_bytes = 100 + (counts.favorites + counts.feedback + counts.ratings) * 300;
        let settings_bytes = 100 + counts.settings * 120;
        let json_bytes = history_bytes * 2
            + fav_bytes
            + settings_bytes
            + counts.playlist_tracks * 700
            + counts.smart_playlists * 1500
            + counts.saved_discoveries * 2000
            + 2000;
        let zip_bytes = ((json_bytes as f64) * 0.4).ceil() as usize;

        ExportSummary {
            generated_at: Utc::now().to_rfc3339(),
            playlists,
            counts,
            estimated_bytes: ExportEstimatedBytes {
                history: history_bytes,
                favorites: fav_bytes,
                settings: settings_bytes,
                json: json_bytes,
                zip: zip_bytes,
            },
            notes: vec![
                String::from(
                    "Sizes are estimates; metadata length and ZIP compression vary. Playlists include your private lists and shared legacy lists, never another user's private lists.",
                ),
                String::from(
                    "Media files are not included. Media-relative playlist paths resolve from the music root; move exported playlist files there before playback.",
                ),
                String::from(
                    "Missing or inaccessible media paths use credential-free MusicDeck stream URLs, which require a signed-in session and are not portable media files.",
                ),
                String::from(
                    "History includes all recorded listening events, including partial listens. Unknown legacy durations and client names remain empty.",
                ),
                String::from(
                    "Exports read live data in bounded pages, not a database-wide point-in-time snapshot. Avoid editing data during generation.",
                ),
                String::from(
                    "Settings are saved account preferences only. The existing preference backup exports unsaved/device-only preferences.",
                ),
            ],
        }
    }

    /// Exports a single playlist (`playlist_id`) owned/visible to `user_id` as `m3u8` or `xspf`.
    pub async fn export_playlist_text(
        &self,
        user_id: &str,
        playlist_id: &str,
        format: PlaylistExportFormat,
    ) -> Result<String, ExportNotFoundError> {
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| ExportNotFoundError(String::from("Playlist not found.")))?;

        let pl_row = sqlx::query(
            r"
            SELECT id, name, description FROM playlists
            WHERE id = ? AND deleted_at IS NULL
              AND (owner_user_id = ? OR owner_user_id IS NULL)
            ",
        )
        .bind(playlist_id)
        .bind(user_id)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| ExportNotFoundError(String::from("Playlist not found.")))?;

        let pl_name: String = pl_row.try_get("name").unwrap_or_default();

        let item_rows = sqlx::query(
            r"
            SELECT i.*, p.track_json
            FROM playlist_items i
            LEFT JOIN smart_playlist_track_payloads p ON p.track_id = i.library_track_id
            WHERE i.playlist_id = ?
            ORDER BY i.position, i.id
            ",
        )
        .bind(playlist_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let mut out = String::new();
        match format {
            PlaylistExportFormat::M3u8 => {
                out.push_str("#EXTM3U\n#PLAYLIST:");
                out.push_str(&sanitize_single_line(&pl_name));
                out.push('\n');
            }
            PlaylistExportFormat::Xspf => {
                out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
                out.push_str("<playlist version=\"1\" xmlns=\"http://xspf.org/ns/0/\"><title>");
                out.push_str(&xml_text(&pl_name));
                out.push_str("</title><trackList>\n");
            }
        }

        for row in item_rows {
            let track_id = row
                .try_get::<String, _>("library_track_id")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| row.try_get::<String, _>("provider_track_id").ok())
                .unwrap_or_default();

            let raw_meta = row
                .try_get::<String, _>("external_track_json")
                .ok()
                .or_else(|| row.try_get::<String, _>("track_json").ok());
            let meta_val = raw_meta
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or_else(|| json!({}));

            let title = meta_val
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(&track_id);
            let artist = meta_val
                .get("artistName")
                .or_else(|| meta_val.get("artist"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let album = meta_val
                .get("albumName")
                .or_else(|| meta_val.get("album"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let duration_secs = meta_val.get("durationSeconds").and_then(Value::as_f64);
            let location = format!(
                "{}api/tracks/{}/stream",
                self.public_url,
                urlencoding::encode(&track_id)
            );

            match format {
                PlaylistExportFormat::M3u8 => {
                    let dur_i = duration_secs.map_or(-1_i64, |d| (d.round() as i64).max(0));
                    out.push_str(&format!(
                        "#EXTINF:{dur_i},{} - {}\n{location}\n",
                        sanitize_single_line(artist),
                        sanitize_single_line(title)
                    ));
                }
                PlaylistExportFormat::Xspf => {
                    out.push_str("<track><location>");
                    out.push_str(&xml_text(&location));
                    out.push_str("</location><identifier>urn:musicdeck:track:");
                    out.push_str(&urlencoding::encode(&track_id));
                    out.push_str("</identifier><title>");
                    out.push_str(&xml_text(title));
                    out.push_str("</title><creator>");
                    out.push_str(&xml_text(artist));
                    out.push_str("</creator><album>");
                    out.push_str(&xml_text(album));
                    out.push_str("</album>");
                    if let Some(d) = duration_secs {
                        let ms = ((d * 1000.0).round() as i64).max(0);
                        out.push_str(&format!("<duration>{ms}</duration>"));
                    }
                    out.push_str("</track>\n");
                }
            }
        }

        if format == PlaylistExportFormat::Xspf {
            out.push_str("</trackList></playlist>\n");
        }

        Ok(out)
    }

    /// Exports listening history for `user_id` as an RFC 4180 CSV document.
    pub async fn export_history_csv(&self, user_id: &str) -> String {
        let mut out = String::from(
            "timestamp,track_title,artist,album,play_duration_seconds,client_name\r\n",
        );
        let Some(pool) = &self.db else {
            return out;
        };

        let mut cursor = 0_i64;
        loop {
            let rows = sqlx::query(
                r"
                SELECT
                    t.rowid AS _rowid,
                    t.track_id,
                    t.created_at,
                    t.listened_seconds,
                    t.client_name,
                    t.track_json,
                    c.title AS cached_title,
                    c.artist AS cached_artist,
                    c.album AS cached_album
                FROM listening_events t
                LEFT JOIN smart_playlist_tracks c ON c.id = t.track_id
                WHERE t.user_id = ? AND t.rowid > ?
                ORDER BY t.rowid
                LIMIT ?
                ",
            )
            .bind(user_id)
            .bind(cursor)
            .bind(EXPORT_PAGE_SIZE)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

            if rows.is_empty() {
                break;
            }

            for r in rows {
                cursor = r.try_get("_rowid").unwrap_or(cursor);
                let ts: String = r.try_get("created_at").unwrap_or_default();
                let track_id: String = r.try_get("track_id").unwrap_or_default();
                let snap_val = r
                    .try_get::<Option<String>, _>("track_json")
                    .ok()
                    .flatten()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or_else(|| json!({}));

                let title = snap_val
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        r.try_get::<Option<String>, _>("cached_title")
                            .ok()
                            .flatten()
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or(track_id);
                let artist = snap_val
                    .get("artist")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        r.try_get::<Option<String>, _>("cached_artist")
                            .ok()
                            .flatten()
                    })
                    .unwrap_or_default();
                let album = snap_val
                    .get("album")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        r.try_get::<Option<String>, _>("cached_album")
                            .ok()
                            .flatten()
                    })
                    .unwrap_or_default();
                let dur_str = r
                    .try_get::<Option<f64>, _>("listened_seconds")
                    .ok()
                    .flatten()
                    .filter(|v| v.is_finite())
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let client: String = r
                    .try_get::<Option<String>, _>("client_name")
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                let cells = [
                    csv_cell(&ts),
                    csv_cell(&title),
                    csv_cell(&artist),
                    csv_cell(&album),
                    csv_cell(&dur_str),
                    csv_cell(&client),
                ];
                out.push_str(&cells.join(","));
                out.push_str("\r\n");
            }
        }

        out
    }

    /// Exports favorites, ratings, and recommendation feedback for `user_id` as JSON.
    pub async fn export_favorites_json(&self, user_id: &str) -> Value {
        let Some(pool) = &self.db else {
            return json!({ "favorites": [], "ratings": [], "feedback": [] });
        };

        let fav_rows = sqlx::query(
            "SELECT track_id, created_at FROM favorites WHERE user_id = ? ORDER BY rowid",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let favorites: Vec<Value> = fav_rows
            .into_iter()
            .filter_map(|r| {
                Some(json!({
                    "item_type": "track",
                    "item_id": r.try_get::<String, _>("track_id").ok()?,
                    "created_at": r.try_get::<String, _>("created_at").unwrap_or_default(),
                }))
            })
            .collect();

        let rat_rows = sqlx::query(
            "SELECT item_type, item_id, rating, updated_at FROM media_ratings WHERE user_id = ? ORDER BY rowid",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let ratings: Vec<Value> = rat_rows
            .into_iter()
            .filter_map(|r| {
                Some(json!({
                    "item_type": r.try_get::<String, _>("item_type").ok()?,
                    "item_id": r.try_get::<String, _>("item_id").ok()?,
                    "rating": r.try_get::<i64, _>("rating").unwrap_or(0),
                    "updated_at": r.try_get::<String, _>("updated_at").unwrap_or_default(),
                }))
            })
            .collect();

        let fb_rows = sqlx::query(
            r"
            SELECT item_type, item_id, action, weight, created_at, updated_at
            FROM recommendation_feedback
            WHERE user_id = ?
            ORDER BY rowid
            ",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let feedback: Vec<Value> = fb_rows
            .into_iter()
            .filter_map(|r| {
                Some(json!({
                    "item_type": r.try_get::<String, _>("item_type").ok()?,
                    "item_id": r.try_get::<String, _>("item_id").ok()?,
                    "action": r.try_get::<String, _>("action").unwrap_or_default(),
                    "weight": r.try_get::<f64, _>("weight").unwrap_or(0.0),
                    "created_at": r.try_get::<String, _>("created_at").unwrap_or_default(),
                    "updated_at": r.try_get::<String, _>("updated_at").unwrap_or_default(),
                }))
            })
            .collect();

        json!({
            "schemaVersion": 1,
            "exportedAt": Utc::now().to_rfc3339(),
            "favorites": favorites,
            "ratings": ratings,
            "feedback": feedback,
        })
    }

    /// Exports allowed user settings for `user_id` as a JSON array.
    pub async fn export_settings_json(&self, user_id: &str) -> Value {
        let Some(pool) = &self.db else {
            return json!([]);
        };
        let rows = sqlx::query(
            "SELECT key, value, updated_at FROM user_settings WHERE user_id = ? ORDER BY rowid",
        )
        .bind(user_id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let items: Vec<Value> = rows
            .into_iter()
            .filter_map(|r| {
                let key: String = r.try_get("key").ok()?;
                if !ALLOWED_USER_SETTINGS.contains(&key.as_str()) {
                    return None;
                }
                let raw_val: String = r.try_get("value").unwrap_or_default();
                let parsed = serde_json::from_str::<Value>(&raw_val)
                    .unwrap_or(Value::String(raw_val));
                let updated_at: String = r.try_get("updated_at").unwrap_or_default();
                Some(json!({
                    "key": key,
                    "value": parsed,
                    "updated_at": updated_at,
                }))
            })
            .collect();

        Value::Array(items)
    }

    /// Exports the complete user data bundle (`user.json`) for `user_id`.
    pub async fn export_bundle_json(&self, user_id: &str) -> Value {
        let summary = self.summary(user_id).await;
        let favorites = self.export_favorites_json(user_id).await;
        let settings = self.export_settings_json(user_id).await;

        json!({
            "schemaVersion": 1,
            "exportedAt": Utc::now().to_rfc3339(),
            "userId": user_id,
            "summary": summary,
            "favorites": favorites,
            "settings": settings,
        })
    }
}
