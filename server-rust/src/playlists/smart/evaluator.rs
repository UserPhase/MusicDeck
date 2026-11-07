//! # Smart Playlist SQL Compiler & Evaluator (`playlists::smart::evaluator`)
//!
//! Complete Rust port of `server/src/services/SmartPlaylistEvaluator.ts`.
//!
//! ## Compilation & Security Guarantees
//! 1. **Zero SQL Interpolation of User Values ([`compile_smart_playlist_rule`])**:
//!    - Every user literal (`title`, `artist`, `genre`, `similar_to` seed ID, numeric threshold,
//!      timestamp) is pushed into `CompiledRule::params` and bound via positional `?`
//!      parameters. User input never enters SQL statement strings.
//!    - Wildcard characters (`%`, `_`, `\`) in `contains` predicates and seed searches are
//!      escaped (`replace(['\\', '%', '_'], "\\$&")`) and paired with `ESCAPE '\'` so literal
//!      track titles like `"100%_song"` match accurately.
//! 2. **Deterministic Seeded Ranking ([`fnv1a_mix_rank`])**:
//!    - Replicates `musicdeck_mix_rank(track_id, seed)` using 32-bit FNV-1a (`2166136261`
//!      offset basis, `16777619` prime) over `"{seed}:{track_id}"` so preview pages,
//!      paginated slices, and saved mix snapshots agree on the exact track sequence and
//!      produce an identical 64-character SHA-256 `selectionToken`.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};
use uuid::Uuid;

use crate::catalog::CatalogListResult;
use crate::db::DbPool;
use crate::playlists::smart::ast::{
    FieldOperator, LeafRule, MixOptions, MixOrder, RuleNode, RuleValue, SmartPlaylistError,
    SmartPlaylistField, parse_smart_playlist_rule,
};
use crate::providers::Track;

/// Typed SQL parameter bound to a `?` placeholder during [`SmartPlaylistEvaluator::evaluate`].
#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    /// Text parameter (`String`).
    Text(String),
    /// 64-bit integer parameter (`i64`).
    Int(i64),
    /// 64-bit float parameter (`f64`).
    Float(f64),
}

/// Output of [`compile_smart_playlist_rule`].
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledRule {
    /// Parameterized SQL `WHERE` predicate (containing only `?` placeholders for user literals).
    pub where_sql: String,
    /// Ordered parameter bindings corresponding to `?` placeholders in `where_sql`.
    pub params: Vec<SqlParam>,
    /// Set of [`SmartPlaylistField`]s referenced in the rule tree (used to determine
    /// whether `LEFT JOIN smart_playlist_activity` or `LEFT JOIN favorites` is required).
    pub fields: HashSet<SmartPlaylistField>,
}

/// Seed track summary returned by [`SmartPlaylistEvaluator::find_seeds`]
/// (`GET /api/v1/smart-playlists/seeds`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeedTrackSummary {
    /// Track ID (`md_...`).
    pub id: String,
    /// Track title.
    pub title: String,
    /// Artist name.
    pub artist: String,
    /// Album title.
    pub album: String,
}

/// Evaluation response returned by [`SmartPlaylistEvaluator::evaluate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartEvaluationResult {
    /// Total tracks in the resulting collection (capped by `mix.size` when `mix` is active).
    pub total: usize,
    /// Total matching tracks in the catalog prior to `mix.size` capping.
    pub available: usize,
    /// SHA-256 token over the ordered track IDs when `mix` is active (verifies preview-to-save consistency).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_token: Option<String>,
    /// Hydrated track payloads for the requested `[offset, offset + limit)` window.
    pub tracks: Vec<Value>,
    /// ISO-8601 timestamp when the catalog projection was last refreshed, if ever.
    pub refreshed_at: Option<String>,
    /// Optional degraded/loading warning message.
    pub warning: Option<String>,
}

/// Compiles a validated [`RuleNode`] AST into a parameterized SQLite `WHERE` clause.
#[must_use]
pub fn compile_smart_playlist_rule(rule: &RuleNode, now_ms: i64) -> CompiledRule {
    let mut params = Vec::new();
    let mut fields = HashSet::new();
    let where_sql = visit_rule_node(rule, now_ms, &mut params, &mut fields);
    CompiledRule {
        where_sql,
        params,
        fields,
    }
}

/// Parses raw JSON and compiles it into a [`CompiledRule`].
pub fn parse_and_compile_rule(
    raw_input: &Value,
    now_ms: i64,
) -> Result<CompiledRule, SmartPlaylistError> {
    let ast = parse_smart_playlist_rule(raw_input)?;
    Ok(compile_smart_playlist_rule(&ast, now_ms))
}

fn visit_rule_node(
    node: &RuleNode,
    now_ms: i64,
    params: &mut Vec<SqlParam>,
    fields: &mut HashSet<SmartPlaylistField>,
) -> String {
    match node {
        RuleNode::Group { operator, rules } => {
            let parts: Vec<String> = rules
                .iter()
                .map(|child| visit_rule_node(child, now_ms, params, fields))
                .collect();
            format!("({})", parts.join(&format!(" {} ", operator.as_sql())))
        }
        RuleNode::Leaf(leaf) => compile_leaf(leaf, now_ms, params, fields),
    }
}

fn compile_leaf(
    leaf: &LeafRule,
    now_ms: i64,
    params: &mut Vec<SqlParam>,
    fields: &mut HashSet<SmartPlaylistField>,
) -> String {
    fields.insert(leaf.field);

    if leaf.field == SmartPlaylistField::SimilarTo {
        if let RuleValue::Text(ref seed_id) = leaf.value {
            params.push(SqlParam::Text(seed_id.clone()));
        }
        return String::from(
            r"t.id IN (SELECT candidate.id FROM smart_playlist_tracks candidate
        JOIN smart_playlist_tracks seed ON seed.id=?
        WHERE candidate.id!=seed.id AND (
          (LOWER(TRIM(seed.artist)) NOT IN ('','unknown artist','[unknown artist]','various artists')
            AND candidate.artist COLLATE NOCASE=seed.artist
            AND (seed.genre IS NULL OR candidate.genre IS NULL))
          OR (EXISTS (SELECT 1 FROM smart_playlist_genres cg
            JOIN smart_playlist_genres sg ON sg.track_id=seed.id AND sg.genre COLLATE NOCASE=cg.genre
            WHERE cg.track_id=candidate.id)
            AND (seed.bpm IS NULL OR seed.bpm<=0 OR candidate.bpm IS NULL OR candidate.bpm<=0
              OR ABS(candidate.bpm-seed.bpm)<=seed.bpm*0.15))))",
        );
    }

    let column = sql_column_for_field(leaf.field);

    if leaf.field == SmartPlaylistField::Genre {
        let raw_text = match &leaf.value {
            RuleValue::Text(s) => s.as_str(),
            _ => "",
        };
        if leaf.operator == FieldOperator::Contains {
            params.push(SqlParam::Text(format!("%{}%", escape_like(raw_text))));
            return String::from(r"t.genre LIKE ? ESCAPE '\'");
        }
        params.push(SqlParam::Text(raw_text.to_owned()));
        let not_prefix = if leaf.operator == FieldOperator::NotEquals {
            "NOT "
        } else {
            ""
        };
        return format!(
            "(t.genre IS NOT NULL AND t.id {not_prefix}IN (SELECT g.track_id FROM smart_playlist_genres g WHERE g.genre COLLATE NOCASE = ?))"
        );
    }

    if matches!(
        leaf.operator,
        FieldOperator::InLastDays | FieldOperator::NotInLastDays
    ) {
        let days = match leaf.value {
            RuleValue::Int(d) => d,
            _ => 1,
        };
        let cutoff_ms = now_ms.saturating_sub(days.saturating_mul(86_400_000));
        params.push(SqlParam::Int(cutoff_ms));
        return if leaf.operator == FieldOperator::InLastDays {
            format!("({column}>0 AND {column}>=?)")
        } else {
            format!("({column}=0 OR {column}<?)")
        };
    }

    if leaf.operator == FieldOperator::Contains {
        let raw_text = match &leaf.value {
            RuleValue::Text(s) => s.as_str(),
            _ => "",
        };
        params.push(SqlParam::Text(format!("%{}%", escape_like(raw_text))));
        return format!(r"{column} LIKE ? ESCAPE '\'");
    }

    let sql_op = match leaf.operator {
        FieldOperator::Equals | FieldOperator::Matches => "=",
        FieldOperator::NotEquals => "!=",
        FieldOperator::GreaterThan => ">",
        FieldOperator::LessThan => "<",
        FieldOperator::Contains | FieldOperator::InLastDays | FieldOperator::NotInLastDays => "=",
    };

    if leaf.field == SmartPlaylistField::LastPlayed {
        let ts_ms = match &leaf.value {
            RuleValue::Text(iso) => DateTime::parse_from_rfc3339(iso)
                .map_or(0, |dt| dt.timestamp_millis()),
            RuleValue::Int(n) => *n,
            _ => 0,
        };
        params.push(SqlParam::Int(ts_ms));
        return format!("({column}>0 AND {column} {sql_op} ?)");
    }

    let is_text = match &leaf.value {
        RuleValue::Text(s) => {
            params.push(SqlParam::Text(s.clone()));
            true
        }
        RuleValue::Int(i) => {
            params.push(SqlParam::Int(*i));
            false
        }
        RuleValue::Float(f) => {
            params.push(SqlParam::Float(*f));
            false
        }
        RuleValue::Bool(b) => {
            params.push(SqlParam::Int(i64::from(*b)));
            false
        }
    };

    let collate = if is_text { " COLLATE NOCASE" } else { "" };
    format!("{column}{collate} {sql_op} ?")
}

const fn sql_column_for_field(field: SmartPlaylistField) -> &'static str {
    match field {
        SmartPlaylistField::Title => "t.title",
        SmartPlaylistField::Artist => "t.artist",
        SmartPlaylistField::Album => "t.album",
        SmartPlaylistField::Genre => "t.genre",
        SmartPlaylistField::Year => "t.year",
        SmartPlaylistField::EraYear => "COALESCE(t.original_year,t.year)",
        SmartPlaylistField::Bpm => "t.bpm",
        SmartPlaylistField::PlayCount => "MAX(COALESCE(s.plays,0),COALESCE(s.recent_plays,0))",
        SmartPlaylistField::SkipCount => "COALESCE(s.skips,0)",
        SmartPlaylistField::IsFavorite => "(f.track_id IS NOT NULL)",
        SmartPlaylistField::LastPlayed => {
            "MAX(COALESCE(s.last_played,0),COALESCE(s.recent_last_played,0))"
        }
        SmartPlaylistField::SimilarTo => "t.id",
    }
}

fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Deterministic 32-bit FNV-1a rank matching `musicdeck_mix_rank(value, seed)`
/// in `server/src/services/SmartPlaylistEvaluator.ts`.
#[must_use]
pub fn fnv1a_mix_rank(track_id: &str, seed: u32) -> u32 {
    let input = format!("{seed}:{track_id}");
    let mut hash: u32 = 2_166_136_261;
    for unit in input.encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    hash
}

fn find_first_similar_seed(node: &RuleNode) -> Option<String> {
    let mut stack = vec![node];
    while let Some(curr) = stack.pop() {
        match curr {
            RuleNode::Group { rules, .. } => {
                for child in rules {
                    stack.push(child);
                }
            }
            RuleNode::Leaf(leaf) => {
                if leaf.field == SmartPlaylistField::SimilarTo
                    && let RuleValue::Text(ref s) = leaf.value
                {
                    return Some(s.clone());
                }
            }
        }
    }
    None
}

/// Evaluates smart playlist rules against the SQLite catalog projection (`smart_playlist_tracks`,
/// `smart_playlist_genres`, `smart_playlist_track_payloads`, `smart_playlist_activity`, and `favorites`).
#[derive(Debug, Clone)]
pub struct SmartPlaylistEvaluator {
    db: DbPool,
}

impl SmartPlaylistEvaluator {
    /// Creates a new [`SmartPlaylistEvaluator`].
    #[must_use]
    pub const fn new(db: DbPool) -> Self {
        Self { db }
    }

    /// Searches up to 12 seed tracks by title/artist (`query.trim().len() >= 2`) or resolves
    /// an exact seed track by `id`.
    pub async fn find_seeds(
        &self,
        query: &str,
        id: Option<&str>,
    ) -> Result<Vec<SeedTrackSummary>, SmartPlaylistError> {
        if let Some(seed_id) = id.filter(|s| !s.trim().is_empty()) {
            let rows = sqlx::query(
                "SELECT id, title, artist, album FROM smart_playlist_tracks WHERE id = ?;",
            )
            .bind(seed_id)
            .fetch_all(self.db.inner())
            .await?;

            return rows
                .into_iter()
                .map(|r| {
                    Ok(SeedTrackSummary {
                        id: r.try_get("id")?,
                        title: r.try_get("title")?,
                        artist: r.try_get("artist")?,
                        album: r.try_get("album")?,
                    })
                })
                .collect();
        }

        let trimmed = query.trim();
        if trimmed.chars().count() < 2 {
            return Ok(Vec::new());
        }

        let pattern = format!("%{}%", escape_like(trimmed));
        let rows = sqlx::query(
            r"
            SELECT id, title, artist, album
            FROM smart_playlist_tracks
            WHERE title LIKE ? ESCAPE '\' OR artist LIKE ? ESCAPE '\'
            ORDER BY title COLLATE NOCASE ASC, id ASC
            LIMIT 12;
            ",
        )
        .bind(&pattern)
        .bind(&pattern)
        .fetch_all(self.db.inner())
        .await?;

        rows.into_iter()
            .map(|r| {
                Ok(SeedTrackSummary {
                    id: r.try_get("id")?,
                    title: r.try_get("title")?,
                    artist: r.try_get("artist")?,
                    album: r.try_get("album")?,
                })
            })
            .collect()
    }

    /// Projects a [`CatalogListResult<Track>`] snapshot into `smart_playlist_tracks`,
    /// `smart_playlist_track_payloads`, `smart_playlist_genres`, and `smart_playlist_catalog_state`.
    pub async fn replace_catalog(
        &self,
        snapshot: &CatalogListResult<Track>,
    ) -> Result<(), SmartPlaylistError> {
        let revision = Uuid::new_v4().to_string();
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        for available_track in &snapshot.items {
            let track = &available_track.item;
            let joined_genres = track
                .genres
                .as_ref()
                .filter(|g| !g.is_empty())
                .map(|g| g.join("\u{001f}"));
            let payload_json = serde_json::to_string(available_track).unwrap_or_else(|_| String::from("{}"));

            sqlx::query(
                r"
                INSERT INTO smart_playlist_tracks
                  (id, title, artist, album, genre, year, bpm, revision, original_year)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title = excluded.title,
                  artist = excluded.artist,
                  album = excluded.album,
                  genre = excluded.genre,
                  year = excluded.year,
                  bpm = excluded.bpm,
                  revision = excluded.revision,
                  original_year = excluded.original_year;
                ",
            )
            .bind(&track.id)
            .bind(&track.title)
            .bind(&track.artist_name)
            .bind(&track.album_name)
            .bind(&joined_genres)
            .bind(track.year)
            .bind(track.bpm)
            .bind(&revision)
            .bind(track.original_release_year)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                r"
                INSERT INTO smart_playlist_track_payloads (track_id, track_json)
                VALUES (?, ?)
                ON CONFLICT(track_id) DO UPDATE SET track_json = excluded.track_json;
                ",
            )
            .bind(&track.id)
            .bind(&payload_json)
            .execute(&mut *tx)
            .await?;

            sqlx::query("DELETE FROM smart_playlist_genres WHERE track_id = ?;")
                .bind(&track.id)
                .execute(&mut *tx)
                .await?;

            if let Some(ref genres) = track.genres {
                for genre in genres {
                    sqlx::query(
                        "INSERT OR IGNORE INTO smart_playlist_genres (track_id, genre) VALUES (?, ?);",
                    )
                    .bind(&track.id)
                    .bind(genre)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        if !snapshot.degraded {
            sqlx::query("DELETE FROM smart_playlist_tracks WHERE revision != ?;")
                .bind(&revision)
                .execute(&mut *tx)
                .await?;
        }

        sqlx::query(
            r"
            INSERT INTO smart_playlist_catalog_state (singleton, refreshed_at, degraded)
            VALUES (1, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
              refreshed_at = excluded.refreshed_at,
              degraded = excluded.degraded,
              mix_revision = mix_revision + 1;
            ",
        )
        .bind(&now_iso)
        .bind(i64::from(snapshot.degraded))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    /// Evaluates `rule` for `user_id` at timestamp `now_ms`, applying optional `mix` ordering
    /// and `[offset, offset + limit)` pagination.
    pub async fn evaluate_at(
        &self,
        user_id: &str,
        rule: &RuleNode,
        limit: usize,
        offset: usize,
        mix: Option<MixOptions>,
        now_ms: i64,
    ) -> Result<SmartEvaluationResult, SmartPlaylistError> {
        if !(1..=500).contains(&limit) {
            return Err(SmartPlaylistError::InvalidRule(String::from(
                "Invalid smart playlist result window",
            )));
        }
        if let Some(ref m) = mix {
            m.validate()?;
        }

        let compiled = compile_smart_playlist_rule(rule, now_ms);
        let needs_activity = compiled.fields.contains(&SmartPlaylistField::PlayCount)
            || compiled.fields.contains(&SmartPlaylistField::SkipCount)
            || compiled.fields.contains(&SmartPlaylistField::LastPlayed)
            || mix.is_some_and(|m| m.order == MixOrder::Rediscover);
        let needs_favorite = compiled.fields.contains(&SmartPlaylistField::IsFavorite);

        let similar_seed = match mix {
            Some(m) if m.order == MixOrder::Similar => find_first_similar_seed(rule),
            _ => None,
        };

        let similarity_expr = if similar_seed.is_some() {
            r"(SELECT (CASE WHEN t.artist COLLATE NOCASE=seed.artist THEN 20 ELSE 0 END)
              + 35*(SELECT COUNT(*) FROM smart_playlist_genres g JOIN smart_playlist_genres sg
                ON sg.track_id=seed.id AND sg.genre COLLATE NOCASE=g.genre WHERE g.track_id=t.id)
              + CASE WHEN t.bpm>0 AND seed.bpm>0 THEN MAX(0,20-ABS(t.bpm-seed.bpm)) ELSE 0 END
              FROM smart_playlist_tracks seed WHERE seed.id=?)"
        } else {
            "0"
        };

        let last_played_expr = if needs_activity {
            "MAX(COALESCE(s.last_played,0),COALESCE(s.recent_last_played,0))"
        } else {
            "0"
        };

        let sql = format!(
            r"
            SELECT
              t.id AS track_id,
              t.title AS track_title,
              payload.track_json AS track_json,
              {last_played_expr} AS last_played_val,
              {similarity_expr} AS sim_score
            FROM smart_playlist_tracks t
            JOIN smart_playlist_track_payloads payload ON payload.track_id = t.id
            {}
            {}
            WHERE {}
            ORDER BY t.title COLLATE NOCASE ASC, t.id ASC;
            ",
            if needs_activity {
                "LEFT JOIN smart_playlist_activity s ON s.track_id = t.id AND s.user_id = ?"
            } else {
                ""
            },
            if needs_favorite {
                "LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = ?"
            } else {
                ""
            },
            compiled.where_sql
        );

        let mut query_builder = sqlx::query(&sql);
        if let Some(ref seed) = similar_seed {
            query_builder = query_builder.bind(seed);
        }
        if needs_activity {
            query_builder = query_builder.bind(user_id);
        }
        if needs_favorite {
            query_builder = query_builder.bind(user_id);
        }
        for param in &compiled.params {
            query_builder = match param {
                SqlParam::Text(s) => query_builder.bind(s),
                SqlParam::Int(i) => query_builder.bind(*i),
                SqlParam::Float(f) => query_builder.bind(*f),
            };
        }

        let raw_rows = query_builder.fetch_all(self.db.inner()).await?;
        let available = raw_rows.len();

        struct CandidateRow {
            id: String,
            track_json: String,
            last_played: i64,
            sim_score: f64,
        }

        let mut candidates: Vec<CandidateRow> = Vec::with_capacity(available);
        for r in raw_rows {
            candidates.push(CandidateRow {
                id: r.try_get("track_id")?,
                track_json: r.try_get("track_json")?,
                last_played: r.try_get::<i64, _>("last_played_val").unwrap_or(0),
                sim_score: r.try_get::<f64, _>("sim_score").unwrap_or(0.0),
            });
        }

        let (total, selection_token, sliced) = if let Some(mix_opts) = mix {
            candidates.sort_by(|a, b| {
                let primary_cmp = match mix_opts.order {
                    MixOrder::Similar if similar_seed.is_some() => b
                        .sim_score
                        .partial_cmp(&a.sim_score)
                        .unwrap_or(std::cmp::Ordering::Equal),
                    MixOrder::Rediscover => a.last_played.cmp(&b.last_played),
                    _ => std::cmp::Ordering::Equal,
                };
                primary_cmp
                    .then_with(|| {
                        fnv1a_mix_rank(&a.id, mix_opts.seed)
                            .cmp(&fnv1a_mix_rank(&b.id, mix_opts.seed))
                    })
                    .then_with(|| a.id.cmp(&b.id))
            });

            let capped_total = available.min(mix_opts.size);
            let token_rows: Vec<Value> = candidates
                .iter()
                .take(mix_opts.size)
                .map(|c| json!({ "id": c.id }))
                .collect();
            let digest = Sha256::digest(serde_json::to_string(&token_rows).unwrap_or_default().as_bytes());
            let mut token_hex = String::with_capacity(64);
            for b in digest {
                use std::fmt::Write;
                let _ = write!(&mut token_hex, "{b:02x}");
            }

            let take_count = capped_total.saturating_sub(offset).min(limit);
            let page: Vec<Value> = candidates
                .into_iter()
                .skip(offset)
                .take(take_count)
                .filter_map(|c| serde_json::from_str::<Value>(&c.track_json).ok())
                .collect();

            (capped_total, Some(token_hex), page)
        } else {
            let take_count = available.saturating_sub(offset).min(limit);
            let page: Vec<Value> = candidates
                .into_iter()
                .skip(offset)
                .take(take_count)
                .filter_map(|c| serde_json::from_str::<Value>(&c.track_json).ok())
                .collect();
            (available, None, page)
        };

        let state_row = sqlx::query(
            "SELECT refreshed_at, degraded FROM smart_playlist_catalog_state WHERE singleton = 1;",
        )
        .fetch_optional(self.db.inner())
        .await?;

        let (refreshed_at, warning) = match state_row {
            None => (
                None,
                Some(String::from(
                    "The local catalog index is still loading. Try previewing again shortly.",
                )),
            ),
            Some(row) => {
                let ref_at: String = row.try_get("refreshed_at")?;
                let deg: i64 = row.try_get("degraded")?;
                let warn = (deg != 0).then(|| {
                    String::from(
                        "Some library sources are unavailable. Results include their last indexed metadata.",
                    )
                });
                (Some(ref_at), warn)
            }
        };

        Ok(SmartEvaluationResult {
            total,
            available,
            selection_token,
            tracks: sliced,
            refreshed_at,
            warning,
        })
    }
}
