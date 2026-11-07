//! # Core Music, Streaming, Artwork, Favorites & Listening Activity Routes (`routes::music`)
//!
//! Complete Rust port of core catalog, streaming, artwork, favorites, recently-played,
//! and listening-activity endpoints from `server/src/routes/music-routes.ts` and
//! `server/src/routes/listening-activity-routes.ts`.
//!
//! ## Endpoints Mounted
//! - **Catalog & Search**:
//!   - `GET /api/albums`, `GET /api/albums/:album_id`, `GET /api/albums/:album_id/tracks`
//!   - `GET /api/artists`, `GET /api/artists/:artist_id`, `GET /api/artists/:artist_id/albums`,
//!     `GET /api/artists/:artist_id/tracks`, `GET /api/artists/:artist_id/top-tracks`
//!   - `GET /api/tracks`, `GET /api/tracks/:track_id`
//!   - `GET /api/search`
//! - **Streaming, Inspection & Artwork**:
//!   - `GET /api/tracks/:track_id/stream` (and alias `GET /api/stream/:track_id`)
//!   - `GET /api/v1/stream/inspect/:track_id`
//!   - `GET /api/artwork/:artwork_id`
//! - **Favorites & Recently Played**:
//!   - `GET /api/favorites/tracks`, `PUT /api/favorites/tracks/:track_id`, `DELETE /api/favorites/tracks/:track_id`
//!   - `GET /api/favorites/albums`, `PUT /api/library/:item_type/:item_id/favorite`
//!   - `GET /api/recently-played`, `POST /api/recently-played`
//! - **Listening Activity & Analytics**:
//!   - `POST /api/listening-events`
//!   - `GET /api/listening-activity/config`
//!   - `GET /api/listening-activity/history`
//!   - `GET /api/listening-activity/statistics`

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::header::RANGE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthenticatedUser;
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::db::DbPool;
use crate::error::ServerError;
use crate::services::favorites::{
    list_favorite_albums, list_favorite_track_ids, set_media_favorite, set_track_favorite,
};
use crate::services::listening_activity::{
    ActivityPeriod, HistoryCursor, ListeningActivityError, PlaybackEventInput, listening_history,
    listening_statistics, listening_threshold, record_playback_with_scrobbles,
};
use crate::services::recently_played::{add_recently_played, list_recently_played_entries};
use crate::state::AppState;
use crate::streaming::{proxy_upstream_stream, send_error_response};

#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize)]
struct RecentlyPlayedPostBody {
    #[serde(rename = "trackId")]
    track_id: String,
}

#[derive(Debug, Deserialize)]
struct MediaFavoritePutBody {
    liked: bool,
    metadata: Option<Value>,
}

/// Registers all core music, streaming, artwork, favorites, recently-played,
/// and listening-activity routes.
pub fn music_routes() -> Router<AppState> {
    Router::new()
        // Catalog endpoints
        .route("/api/albums", get(list_albums_handler))
        .route("/api/albums/:album_id", get(get_album_handler))
        .route("/api/albums/:album_id/artwork", get(get_album_artwork_handler))
        .route("/api/albums/:album_id/tracks", get(get_album_tracks_handler))
        .route("/api/artists", get(list_artists_handler))
        .route("/api/artists/:artist_id", get(get_artist_handler))
        .route("/api/artists/:artist_id/albums", get(get_artist_albums_handler))
        .route("/api/artists/:artist_id/tracks", get(get_artist_tracks_handler))
        .route(
            "/api/artists/:artist_id/top-tracks",
            get(get_artist_top_tracks_handler),
        )
        .route("/api/tracks", get(list_tracks_handler))
        .route("/api/tracks/recently-added", get(list_recently_added_tracks_handler))
        .route("/api/tracks/:track_id", get(get_track_handler))
        .route("/api/library/random-albums", get(get_random_albums_handler))
        .route("/api/library/random-tracks", get(get_random_tracks_handler))
        .route("/api/library/tracks/filter", post(post_filter_tracks_handler))
        .route("/api/library/matches", post(post_library_matches_handler))
        .route("/api/search", get(search_catalog_handler))
        // Streaming, inspection & artwork
        .route("/api/tracks/:track_id/stream", get(stream_track_handler))
        .route("/api/stream/:track_id", get(stream_track_handler))
        .route(
            "/api/v1/stream/inspect/:track_id",
            get(inspect_stream_handler),
        )
        .route("/api/artwork/:artwork_id", get(fetch_artwork_handler))
        // Favorites & recently played
        .route("/api/favorites/tracks", get(get_favorite_tracks_handler))
        .route(
            "/api/favorites/tracks/:track_id",
            put(put_favorite_track_handler).delete(delete_favorite_track_handler),
        )
        .route("/api/favorites/albums", get(get_favorite_albums_handler))
        .route(
            "/api/library/:item_type/:item_id/favorite",
            put(put_media_favorite_handler),
        )
        .route(
            "/api/recently-played",
            get(get_recently_played_handler).post(post_recently_played_handler),
        )
        // Listening activity & telemetry
        .route("/api/listening-events", post(post_listening_event_handler))
        .route(
            "/api/listening-activity/config",
            get(get_listening_activity_config_handler),
        )
        .route(
            "/api/listening-activity/history",
            get(get_listening_activity_history_handler),
        )
        .route(
            "/api/listening-activity/statistics",
            get(get_listening_activity_statistics_handler),
        )
}

fn require_db(state: &AppState) -> Result<&DbPool, ServerError> {
    state
        .db()
        .ok_or_else(|| ServerError::Internal(String::from("Database pool is not initialized")))
}

fn build_catalog_and_resolver(state: &AppState) -> Result<(CatalogService, SourceResolver, LibraryService), Response> {
    let Some(db) = state.db().cloned() else {
        return Err(send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database pool is not initialized",
            "BACKEND_ERROR",
        ));
    };
    let library = LibraryService::new(db, Some(state.config().music_root.clone()));
    let registry = state.providers().clone();
    let catalog = CatalogService::new(registry.clone(), library.clone());
    let resolver = SourceResolver::new(registry, library.clone());
    Ok((catalog, resolver, library))
}

// ============================================================================
// Catalog Handlers
// ============================================================================

async fn list_albums_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<u32>().ok())
        .map(|l| l.clamp(1, 500));
    let offset = params
        .get("offset")
        .and_then(|s| s.parse::<usize>().ok());

    match catalog.list_albums(if offset.is_some() { Some(500) } else { limit }).await {
        Ok(res) => {
            let total = res.items.len();
            let albums: Vec<_> = match (offset, limit) {
                (Some(off), Some(lim)) => res
                    .items
                    .into_iter()
                    .skip(off)
                    .take(lim as usize)
                    .collect(),
                (Some(off), None) => res.items.into_iter().skip(off).take(200).collect(),
                _ => res.items,
            };
            Json(json!({
                "albums": albums,
                "total": total,
                "degraded": res.degraded,
            }))
            .into_response()
        }
        Err(err) => send_error_response(StatusCode::BAD_GATEWAY, err.to_string(), "BACKEND_ERROR"),
    }
}

fn recording_title_key(title: &str) -> String {
    format!(
        "{}|{}",
        crate::catalog::normalize_music_text(Some(title)),
        crate::catalog::version_signature(Some(title))
    )
}

fn local_and_external_tracks_match(
    local: &crate::providers::Track,
    ext: &Value,
) -> bool {
    if let (Some(local_isrc), Some(ext_isrc)) = (
        local
            .identity_hints
            .as_ref()
            .and_then(|h| h.isrc.as_deref())
            .map(|s| crate::catalog::normalize_music_text(Some(s)))
            .filter(|s| !s.is_empty()),
        ext.get("metadata")
            .and_then(|m| m.get("isrc"))
            .and_then(Value::as_str)
            .map(|s| crate::catalog::normalize_music_text(Some(s)))
            .filter(|s| !s.is_empty()),
    ) {
        return local_isrc == ext_isrc;
    }

    let ext_title = ext
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if recording_title_key(&local.title) != recording_title_key(ext_title) {
        return false;
    }

    let local_artist = crate::catalog::normalize_music_text(Some(&local.artist_name));
    let ext_artist = ext
        .get("artist")
        .or_else(|| ext.get("artistName"))
        .and_then(Value::as_str)
        .map(|s| crate::catalog::normalize_music_text(Some(s)))
        .unwrap_or_default();
    if local_artist.is_empty() || ext_artist.is_empty() {
        return false;
    }

    let artist_matches = local_artist == ext_artist
        || local_artist.contains(&ext_artist)
        || ext_artist.contains(&local_artist)
        || local.artist_credits.as_ref().is_some_and(|credits| {
            credits
                .iter()
                .any(|c| crate::catalog::normalize_music_text(Some(&c.name)) == ext_artist)
        });
    if !artist_matches {
        return false;
    }

    let local_dur = i64::from(local.duration_seconds.unwrap_or(0));
    let ext_dur = ext
        .get("durationSeconds")
        .or_else(|| ext.get("metadata").and_then(|m| m.get("durationSeconds")))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    local_dur == 0 || ext_dur == 0 || (local_dur - ext_dur).abs() <= 20
}

fn merge_local_and_external_album_tracks(
    local_candidates: &[crate::catalog::Available<crate::providers::Track>],
    album_local_tracks: &[crate::catalog::Available<crate::providers::Track>],
    external_tracks: &[Value],
    append_unmatched_local: bool,
) -> (Vec<Value>, usize) {
    let mut matched_local_ids = HashSet::new();
    let mut merged = Vec::with_capacity(external_tracks.len() + album_local_tracks.len());
    let mut local_count = 0usize;

    for ext_tr in external_tracks {
        if let Some(local_match) = local_candidates
            .iter()
            .find(|lt| local_and_external_tracks_match(&lt.item, ext_tr))
        {
            matched_local_ids.insert(local_match.item.id.clone());
            local_count += 1;
            if let Ok(mut local_val) = serde_json::to_value(local_match) {
                local_val["inLibrary"] = json!(true);
                local_val["localTrackId"] = json!(local_match.item.id);
                local_val["provider"] = json!("library");
                local_val["source"] = json!({ "kind": "library", "count": 1 });
                if local_match.item.artwork_id.is_none() {
                    if let Some(art_id) = ext_tr.get("artworkId") {
                        local_val["artworkId"] = art_id.clone();
                    }
                    if let Some(art_url) = ext_tr.get("artworkUrl") {
                        local_val["artworkUrl"] = art_url.clone();
                    }
                    if let Some(art) = ext_tr.get("artwork") {
                        local_val["artwork"] = art.clone();
                    }
                }
                merged.push(local_val);
            }
        } else {
            merged.push(ext_tr.clone());
        }
    }

    if append_unmatched_local {
        for lt in album_local_tracks {
            if matched_local_ids.insert(lt.item.id.clone()) {
                local_count += 1;
                if let Ok(mut local_val) = serde_json::to_value(lt) {
                    local_val["inLibrary"] = json!(true);
                    local_val["localTrackId"] = json!(lt.item.id);
                    local_val["provider"] = json!("library");
                    local_val["source"] = json!({ "kind": "library", "count": 1 });
                    merged.push(local_val);
                }
            }
        }
    }

    (merged, local_count)
}

async fn resolve_local_album_with_external_tracks(
    state: &AppState,
    user: &crate::auth::SessionUser,
    catalog: &CatalogService,
    prov: &crate::providers::RegisteredProvider,
    prov_album_id: &str,
    stamped_album: &crate::catalog::Available<crate::providers::Album>,
) -> (Vec<Value>, usize) {
    let raw_album_tracks = prov
        .provider
        .get_album_tracks(prov_album_id)
        .await
        .unwrap_or_default();
    let mut stamped_album_tracks = Vec::with_capacity(raw_album_tracks.len());
    for tr in raw_album_tracks {
        if let Ok(st) = catalog.stamp_track(tr, &prov.connection_id).await {
            stamped_album_tracks.push(st);
        }
    }

    let external_allowed = (user.is_admin() || user.external_search_enabled)
        && state
            .privacy()
            .is_external_allowed(crate::services::privacy::ExternalCategory::Metadata);
    if !external_allowed {
        let local_vals: Vec<Value> = stamped_album_tracks
            .iter()
            .filter_map(|t| serde_json::to_value(t).ok())
            .collect();
        let len = local_vals.len();
        return (local_vals, len);
    }

    // Also include all local tracks for the same artist so tracks filed under singles/compilations match
    let mut local_candidates = stamped_album_tracks.clone();
    if let Ok(all_tracks_res) = catalog.search(&stamped_album.item.artist_name, &["track"], None).await {
        for t in all_tracks_res.tracks {
            if !local_candidates.iter().any(|c| c.item.id == t.item.id) {
                local_candidates.push(t);
            }
        }
    }

    let query = format!(
        "{} {}",
        stamped_album.item.name, stamped_album.item.artist_name
    )
    .trim()
    .to_owned();
    let target_album_key = crate::catalog::normalize_music_text(Some(&stamped_album.item.name));
    let target_artist_key =
        crate::catalog::normalize_music_text(Some(&stamped_album.item.artist_name));

    let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 10);
    let itunes = crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 10);

    let (dz_albums, it_albums) = tokio::join!(
        crate::external::ExternalProvider::search_albums(&deezer, &query),
        crate::external::ExternalProvider::search_albums(&itunes, &query)
    );

    let matches_album = |item: &crate::external::ExternalSearchItem| {
        let item_title = crate::catalog::normalize_music_text(Some(&item.title));
        let item_artist = crate::catalog::normalize_music_text(item.artist.as_deref());
        item_title == target_album_key
            && (target_artist_key.is_empty()
                || item_artist == target_artist_key
                || item_artist.contains(&target_artist_key)
                || target_artist_key.contains(&item_artist))
    };

    let matched_dz_id = dz_albums
        .ok()
        .and_then(|list| list.into_iter().find(matches_album).map(|a| a.id));
    let matched_it_id = it_albums
        .ok()
        .and_then(|list| list.into_iter().find(matches_album).map(|a| a.id));

    let ext_detail = if let Some(ref dz_id) = matched_dz_id {
        deezer.get_album(dz_id).await
    } else if let Some(ref it_id) = matched_it_id {
        itunes.get_album(it_id).await
    } else {
        None
    };

    if let Some(detail) = ext_detail {
        if let Some(ext_tracks) = detail.get("tracks").and_then(Value::as_array) {
            if !ext_tracks.is_empty() {
                return merge_local_and_external_album_tracks(
                    &local_candidates,
                    &stamped_album_tracks,
                    ext_tracks,
                    true,
                );
            }
        }
    }

    let local_vals: Vec<Value> = stamped_album_tracks
        .iter()
        .filter_map(|t| serde_json::to_value(t).ok())
        .collect();
    let len = local_vals.len();
    (local_vals, len)
}

async fn resolve_external_album_with_local_tracks(
    state: &AppState,
    album_id: &str,
) -> Option<Value> {
    let mut album = if album_id.starts_with("external_itunes_album_") {
        crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25)
            .get_album(album_id)
            .await?
    } else {
        crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25)
            .get_album(album_id)
            .await?
    };

    let Some(pool) = state.db() else {
        return Some(album);
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let artist_name = album
        .get("artist")
        .or_else(|| album.get("artistName"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    if artist_name.is_empty() {
        return Some(album);
    }

    let Ok(search_res) = catalog.search(&artist_name, &["track"], None).await else {
        return Some(album);
    };
    if search_res.tracks.is_empty() {
        return Some(album);
    }

    let Some(ext_tracks) = album.get("tracks").and_then(Value::as_array).cloned() else {
        return Some(album);
    };

    let (merged_tracks, local_count) = merge_local_and_external_album_tracks(
        &search_res.tracks,
        &[],
        &ext_tracks,
        false,
    );
    album["tracks"] = json!(merged_tracks);
    album["trackCount"] = json!(merged_tracks.len());
    album["localTrackCount"] = json!(local_count);
    Some(album)
}

async fn get_album_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(album_id): Path<String>,
) -> Response {
    if album_id.starts_with("external_") || album_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        if let Some(album) = resolve_external_album_with_local_tracks(&state, &album_id).await {
            return Json(json!({ "album": album })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Album not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let mut targets: Vec<(crate::providers::RegisteredProvider, String)> = resolver
        .candidate_sources(&album_id, None)
        .await
        .into_iter()
        .map(|c| (c.provider, c.source.provider_item_id))
        .collect();
    if targets.is_empty() {
        for p in state.providers().list() {
            if p.enabled {
                targets.push((p, album_id.clone()));
            }
        }
    }

    for (prov, prov_album_id) in targets {
        if let Ok(Some(album)) = prov.provider.get_album(&prov_album_id).await
            && let Ok(stamped) = catalog.stamp_album(album, &prov.connection_id).await
        {
            let (tracks, local_count) = resolve_local_album_with_external_tracks(
                &state,
                &auth.user,
                &catalog,
                &prov,
                &prov_album_id,
                &stamped,
            )
            .await;
            let mut album_val = serde_json::to_value(&stamped).unwrap_or_else(|_| json!({}));
            album_val["trackCount"] = json!(tracks.len());
            album_val["localTrackCount"] = json!(local_count);
            return Json(json!({ "album": album_val })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Album not found", "NOT_FOUND")
}

async fn get_album_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(album_id): Path<String>,
) -> Response {
    if album_id.starts_with("external_") || album_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        if let Some(album) = resolve_external_album_with_local_tracks(&state, &album_id).await {
            let tracks = album.get("tracks").cloned().unwrap_or_else(|| json!([]));
            return Json(json!({ "tracks": tracks })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Album not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let mut targets: Vec<(crate::providers::RegisteredProvider, String)> = resolver
        .candidate_sources(&album_id, None)
        .await
        .into_iter()
        .map(|c| (c.provider, c.source.provider_item_id))
        .collect();
    if targets.is_empty() {
        for p in state.providers().list() {
            if p.enabled {
                targets.push((p, album_id.clone()));
            }
        }
    }

    for (prov, prov_album_id) in targets {
        if let Ok(Some(album)) = prov.provider.get_album(&prov_album_id).await
            && let Ok(stamped) = catalog.stamp_album(album, &prov.connection_id).await
        {
            let (tracks, _) = resolve_local_album_with_external_tracks(
                &state,
                &auth.user,
                &catalog,
                &prov,
                &prov_album_id,
                &stamped,
            )
            .await;
            return Json(json!({ "tracks": tracks })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Album not found", "NOT_FOUND")
}

async fn list_artists_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    match catalog.list_artists().await {
        Ok(res) => Json(json!({
            "artists": res.items,
            "degraded": res.degraded,
        }))
        .into_response(),
        Err(err) => send_error_response(StatusCode::BAD_GATEWAY, err.to_string(), "BACKEND_ERROR"),
    }
}

async fn get_artist_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Response {
    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        let artist_opt = if artist_id.starts_with("external_itunes_artist_") {
            crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        } else {
            crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        };
        if let Some(artist) = artist_opt {
            return Json(json!({ "artist": artist })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let candidates = resolver.candidate_sources(&artist_id, None).await;
    for candidate in candidates {
        if let Ok(Some(artist)) = candidate
            .provider
            .provider
            .get_artist(&candidate.source.provider_item_id, true)
            .await
            && let Ok(stamped) = catalog
                .stamp_artist(artist, &candidate.source.connection_id)
                .await
        {
            return Json(json!({ "artist": stamped })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

async fn get_artist_albums_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Response {
    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        let artist_opt = if artist_id.starts_with("external_itunes_artist_") {
            crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        } else {
            crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        };
        if let Some(artist) = artist_opt {
            let albums = artist.get("albums").cloned().unwrap_or_else(|| json!([]));
            return Json(json!({ "albums": albums })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let candidates = resolver.candidate_sources(&artist_id, None).await;
    for candidate in candidates {
        if let Ok(albums) = candidate
            .provider
            .provider
            .get_artist_albums(&candidate.source.provider_item_id)
            .await
        {
            let mut stamped = Vec::with_capacity(albums.len());
            for album in albums {
                if let Ok(sa) = catalog
                    .stamp_album(album, &candidate.source.connection_id)
                    .await
                {
                    stamped.push(sa);
                }
            }
            return Json(json!({ "albums": stamped })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

async fn get_artist_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Response {
    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        let artist_opt = if artist_id.starts_with("external_itunes_artist_") {
            crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        } else {
            crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        };
        if let Some(artist) = artist_opt {
            let tracks = artist.get("tracks").cloned().unwrap_or_else(|| json!([]));
            return Json(json!({ "tracks": tracks })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let candidates = resolver.candidate_sources(&artist_id, None).await;
    for candidate in candidates {
        if let Ok(tracks) = candidate
            .provider
            .provider
            .get_artist_tracks(&candidate.source.provider_item_id)
            .await
        {
            let mut stamped = Vec::with_capacity(tracks.len());
            for track in tracks {
                if let Ok(st) = catalog
                    .stamp_track(track, &candidate.source.connection_id)
                    .await
                {
                    stamped.push(st);
                }
            }
            return Json(json!({ "tracks": stamped })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

async fn get_artist_top_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 10);

    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        if let Err(err) = state
            .privacy()
            .assert_external_allowed(crate::services::privacy::PrivacyCategory::Metadata)
        {
            return crate::routes::privacy::map_privacy_error(err);
        }
        if !auth.user.is_admin() && !auth.user.external_search_enabled {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        let artist_opt = if artist_id.starts_with("external_itunes_artist_") {
            crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        } else {
            crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25)
                .get_artist(&artist_id)
                .await
        };
        if let Some(artist) = artist_opt {
            let tracks = artist
                .get("tracks")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().take(limit).cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            return Json(json!({ "tracks": tracks })).into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    }

    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let mut targets: Vec<(crate::providers::RegisteredProvider, String)> = resolver
        .candidate_sources(&artist_id, None)
        .await
        .into_iter()
        .map(|c| (c.provider, c.source.provider_item_id))
        .collect();
    if targets.is_empty() {
        for p in state.providers().list() {
            if p.enabled {
                targets.push((p, artist_id.clone()));
            }
        }
    }

    for (prov, prov_artist_id) in targets {
        let Ok(Some(artist)) = prov.provider.get_artist(&prov_artist_id, false).await else {
            continue;
        };
        let mut raw_tracks = prov
            .provider
            .get_artist_top_tracks(&prov_artist_id, limit)
            .await
            .unwrap_or_default();
        if raw_tracks.is_empty() {
            raw_tracks = prov
                .provider
                .get_artist_tracks(&prov_artist_id)
                .await
                .unwrap_or_default();
        }

        let mut local_stamped = Vec::new();
        for track in raw_tracks {
            if let Ok(st) = catalog.stamp_track(track, &prov.connection_id).await {
                local_stamped.push(st);
            }
        }

        let external_allowed = (auth.user.is_admin() || auth.user.external_search_enabled)
            && state
                .privacy()
                .is_external_allowed(crate::services::privacy::ExternalCategory::Metadata);

        let mut merged_tracks: Vec<Value> = Vec::new();
        let mut seen_keys = HashSet::new();

        if external_allowed {
            let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 8);
            let target_key = crate::catalog::normalize_music_text(Some(&artist.name));
            if let Ok(candidates) =
                crate::external::ExternalProvider::search_artists(&deezer, &artist.name).await
            {
                if let Some(matched) = candidates
                    .into_iter()
                    .find(|c| crate::catalog::normalize_music_text(Some(&c.title)) == target_key)
                {
                    if let Some(detail) = deezer.get_artist(&matched.id).await {
                        if let Some(ext_tracks) = detail.get("tracks").and_then(Value::as_array) {
                            for ext_tr in ext_tracks {
                                if merged_tracks.len() >= limit {
                                    break;
                                }
                                let ext_title = ext_tr
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                let norm_title =
                                    crate::catalog::normalize_music_text(Some(ext_title));
                                if norm_title.is_empty() || !seen_keys.insert(norm_title.clone()) {
                                    continue;
                                }
                                if let Some(local_match) = local_stamped.iter().find(|lt| {
                                    crate::catalog::normalize_music_text(Some(&lt.item.title))
                                        == norm_title
                                }) {
                                    if let Ok(mut val) = serde_json::to_value(local_match) {
                                        val["coverArt"] = json!(local_match.item.artwork_id);
                                        val["duration"] = json!(local_match.item.duration_seconds);
                                        val["isDownloaded"] = json!(true);
                                        val["discographySource"] = json!("local");
                                        merged_tracks.push(val);
                                    }
                                } else {
                                    let mut val = ext_tr.clone();
                                    val["coverArt"] =
                                        ext_tr.get("artworkId").cloned().unwrap_or(Value::Null);
                                    val["duration"] = ext_tr
                                        .get("durationSeconds")
                                        .cloned()
                                        .unwrap_or(Value::Null);
                                    val["isDownloaded"] = json!(false);
                                    val["discographySource"] = json!("external");
                                    merged_tracks.push(val);
                                }
                            }
                        }
                    }
                }
            }
        }

        for lt in &local_stamped {
            if merged_tracks.len() >= limit {
                break;
            }
            let norm_title = crate::catalog::normalize_music_text(Some(&lt.item.title));
            if seen_keys.insert(norm_title) {
                if let Ok(mut val) = serde_json::to_value(lt) {
                    val["coverArt"] = json!(lt.item.artwork_id);
                    val["duration"] = json!(lt.item.duration_seconds);
                    val["isDownloaded"] = json!(true);
                    val["discographySource"] = json!("local");
                    merged_tracks.push(val);
                }
            }
        }

        return Json(json!({ "tracks": merged_tracks })).into_response();
    }

    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

async fn get_track_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
) -> Response {
    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let candidates = resolver.candidate_sources(&track_id, None).await;
    for candidate in candidates {
        if let Ok(Some(track)) = candidate
            .provider
            .provider
            .get_track(&candidate.source.provider_item_id)
            .await
            && let Ok(stamped) = catalog
                .stamp_track(track, &candidate.source.connection_id)
                .await
        {
            return Json(json!({ "track": stamped })).into_response();
        }
    }

    send_error_response(StatusCode::NOT_FOUND, "Track not found", "NOT_FOUND")
}

async fn search_catalog_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let query = params
        .get("q")
        .or_else(|| params.get("query"))
        .cloned()
        .unwrap_or_default();

    let types = params.get("types").map(|raw| {
        raw.split(',')
            .filter_map(|token| match token.trim() {
                "track" | "tracks" | "songs" => Some(crate::search::SearchResultType::Track),
                "album" | "albums" => Some(crate::search::SearchResultType::Album),
                "artist" | "artists" => Some(crate::search::SearchResultType::Artist),
                "playlist" | "playlists" => Some(crate::search::SearchResultType::Playlist),
                _ => None,
            })
            .collect::<Vec<_>>()
    });

    let requested_mode = match params.get("mode").map(String::as_str) {
        Some("library") => crate::search::SearchMode::Library,
        Some("external") => crate::search::SearchMode::External,
        _ => crate::search::SearchMode::Hybrid,
    };

    let can_search_external = (auth.user.is_admin() || auth.user.external_search_enabled)
        && state
            .privacy()
            .is_external_allowed(crate::services::privacy::ExternalCategory::Metadata);

    if requested_mode == crate::search::SearchMode::External && !can_search_external {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "External search is not available for this user",
            "FORBIDDEN",
        );
    }

    let effective_mode = if can_search_external {
        requested_mode
    } else {
        crate::search::SearchMode::Library
    };

    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok());

    match params.get("phase").map(String::as_str) {
        Some("local") => {
            let opts = crate::search::SearchOptions {
                types,
                mode: crate::search::SearchMode::Library,
                limit,
                user: Some(auth),
            };
            match state.search_providers().search(&query, &opts).await {
                Ok(outcome) => {
                    let groups = crate::search::deduplicate_unified_search_groups(outcome.groups);
                    let mut resp = crate::search::to_legacy_search_response(&groups);
                    resp["results"] = json!(groups);
                    resp["degraded"] = json!(outcome.degraded);
                    Json(resp).into_response()
                }
                Err(_) => Json(json!({
                    "tracks": [],
                    "albums": [],
                    "artists": [],
                    "playlists": [],
                    "results": { "track": [], "album": [], "artist": [], "playlist": [] },
                    "degraded": true,
                }))
                .into_response(),
            }
        }
        Some("external") => {
            if !can_search_external || effective_mode == crate::search::SearchMode::Library {
                return Json(json!({
                    "results": { "track": [], "album": [], "artist": [], "playlist": [] },
                    "degraded": false,
                }))
                .into_response();
            }
            let opts = crate::search::SearchOptions {
                types,
                mode: crate::search::SearchMode::External,
                limit,
                user: Some(auth),
            };
            match state.search_providers().search(&query, &opts).await {
                Ok(outcome) => {
                    let groups = crate::search::deduplicate_unified_search_groups(outcome.groups);
                    Json(json!({
                        "results": groups,
                        "degraded": outcome.degraded,
                    }))
                    .into_response()
                }
                Err(_) => Json(json!({
                    "results": { "track": [], "album": [], "artist": [], "playlist": [] },
                    "degraded": true,
                }))
                .into_response(),
            }
        }
        _ => {
            let opts = crate::search::SearchOptions {
                types,
                mode: effective_mode,
                limit,
                user: Some(auth),
            };
            match state.search_providers().search(&query, &opts).await {
                Ok(outcome) => {
                    let groups = crate::search::deduplicate_unified_search_groups(outcome.groups);
                    let mut resp = crate::search::to_legacy_search_response(&groups);
                    resp["results"] = json!(groups);
                    resp["degraded"] = json!(outcome.degraded);
                    Json(resp).into_response()
                }
                Err(_) => Json(json!({
                    "tracks": [],
                    "albums": [],
                    "artists": [],
                    "playlists": [],
                    "results": { "track": [], "album": [], "artist": [], "playlist": [] },
                    "degraded": true,
                }))
                .into_response(),
            }
        }
    }
}

// ============================================================================
// Stream, Inspection & Artwork Handlers
// ============================================================================

async fn stream_track_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (_, resolver, library) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let range_header = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    if let Some(playable_source) = params
        .get("playableSource")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
    {
        if state
            .source_providers()
            .is_external_source(&track_id, playable_source)
            && !auth.user.is_admin()
            && !auth.user.external_playback_enabled
        {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External playback is not available for this user",
                "FORBIDDEN",
            );
        }

        let external = state
            .source_providers()
            .is_external_source(&track_id, playable_source);
        let fetch = state.source_providers().fetch_stream(
            &track_id,
            playable_source,
            range_header.as_deref(),
        );
        let fetched = if external {
            match state
                .privacy()
                .run_external(crate::services::privacy::PrivacyCategory::External, fetch)
                .await
            {
                Ok(result) => result,
                Err(err) => return crate::routes::privacy::map_privacy_error(err),
            }
        } else {
            fetch.await
        };
        return match fetched {
            Ok(stream_result) => {
                let status = StatusCode::from_u16(stream_result.status).unwrap_or(StatusCode::OK);
                let mut resp_headers = HeaderMap::new();
                for (k, v) in stream_result.headers {
                    if let (Ok(hn), Ok(hv)) = (
                        axum::http::HeaderName::from_bytes(k.as_bytes()),
                        axum::http::HeaderValue::from_str(&v),
                    ) {
                        resp_headers.insert(hn, hv);
                    }
                }
                (
                    status,
                    resp_headers,
                    axum::body::Body::from(stream_result.bytes),
                )
                    .into_response()
            }
            Err(_) => send_error_response(
                StatusCode::BAD_GATEWAY,
                "Playback unavailable",
                "BAD_GATEWAY",
            ),
        };
    }

    if !library.exists(&track_id).await.unwrap_or(false) {
        return send_error_response(StatusCode::NOT_FOUND, "Track not found", "NOT_FOUND");
    }

    let preferred_source = params
        .get("source")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let max_bit_rate = params
        .get("maxBitRate")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|kbps| matches!(kbps, 128 | 192 | 256 | 320));

    let inspection_id = params
        .get("inspectionId")
        .cloned()
        .filter(|s| !s.is_empty());
    if let Some(ref insp_id) = inspection_id
        && (insp_id.len() > 160
            || !insp_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid audio inspection identifier",
            "BAD_REQUEST",
        );
    }

    match resolver
        .fetch_stream(
            &track_id,
            range_header.as_deref(),
            preferred_source,
            max_bit_rate,
        )
        .await
    {
        Ok(stream_result) => {
            let inspection_ctx = inspection_id.map(|insp_id| {
                (
                    state.inspector().clone(),
                    auth.user.id,
                    track_id,
                    insp_id,
                    range_header,
                )
            });
            proxy_upstream_stream(stream_result, inspection_ctx)
        }
        Err(_) => send_error_response(
            StatusCode::BAD_GATEWAY,
            "Playback unavailable",
            "BACKEND_ERROR",
        ),
    }
}

async fn inspect_stream_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(track_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(inspection_id) = params.get("inspectionId").filter(|s| !s.trim().is_empty()) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "inspectionId query parameter is required",
            "VALIDATION_ERROR",
        );
    };

    let (_, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let source_meta = resolver
        .audio_metadata(&track_id, None)
        .await
        .map_err(|_| ());

    let report = state.inspector().inspect_snapshot(
        &auth.user.id,
        &track_id,
        inspection_id,
        source_meta,
    );
    Json(report).into_response()
}

async fn fetch_artwork_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artwork_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let size = params
        .get("size")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|&px| px > 0 && px <= 2048);

    // If `artwork_id` is a `mdplart_<signature>_<playlistId>` token, resolve playlist cover art.
    if let Some((playlist_id, _sig)) = crate::playlists::parse_playlist_artwork_id(&artwork_id) {
        let (catalog, resolver, library) = match build_catalog_and_resolver(&state) {
            Ok(t) => t,
            Err(res) => return res,
        };
        let Some(db) = state.db().cloned() else {
            return send_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database unavailable",
                "BACKEND_ERROR",
            );
        };
        let service = crate::playlists::PlaylistService::new(db, catalog, library, resolver);
        return match service.render_artwork(&playlist_id, &auth.user, size).await {
            Ok(Some(rendered)) => {
                let mut res = (StatusCode::OK, rendered.body).into_response();
                if let Ok(ct) = axum::http::HeaderValue::from_str(&rendered.content_type) {
                    res.headers_mut()
                        .insert(axum::http::header::CONTENT_TYPE, ct);
                }
                res.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("private, max-age=300"),
                );
                res
            }
            Ok(None) => send_error_response(StatusCode::NOT_FOUND, "Artwork not found", "NOT_FOUND"),
            Err(_) => send_error_response(
                StatusCode::BAD_GATEWAY,
                "Artwork unavailable",
                "BACKEND_ERROR",
            ),
        };
    }

    let (_, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    match resolver.fetch_artwork(&artwork_id, size).await {
        Ok(stream_result) => proxy_upstream_stream(stream_result, None),
        Err(err) if err.all_not_found => {
            send_error_response(StatusCode::NOT_FOUND, "Artwork not found", "NOT_FOUND")
        }
        Err(_) => send_error_response(
            StatusCode::BAD_GATEWAY,
            "Artwork unavailable",
            "BACKEND_ERROR",
        ),
    }
}

// ============================================================================
// Favorites & Recently Played Handlers
// ============================================================================

async fn get_favorite_tracks_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };
    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let Ok(track_ids) = list_favorite_track_ids(db, &auth.user.id).await else {
        return send_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not load favorite tracks",
            "INTERNAL_ERROR",
        );
    };

    let mut tracks = Vec::with_capacity(track_ids.len());
    for track_id in track_ids {
        let candidates = resolver.candidate_sources(&track_id, None).await;
        for candidate in candidates {
            if let Ok(Some(track)) = candidate
                .provider
                .provider
                .get_track(&candidate.source.provider_item_id)
                .await
                && let Ok(stamped) = catalog
                    .stamp_track(track, &candidate.source.connection_id)
                    .await
            {
                tracks.push(stamped);
                break;
            }
        }
    }

    Json(json!({ "tracks": tracks })).into_response()
}

async fn put_favorite_track_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(track_id): Path<String>,
) -> Response {
    if track_id.trim().is_empty() || track_id.contains('/') {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid track ID",
            "VALIDATION_ERROR",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match set_track_favorite(db, &auth.user.id, &track_id, true).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

async fn delete_favorite_track_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(track_id): Path<String>,
) -> Response {
    if track_id.trim().is_empty() || track_id.contains('/') {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid track ID",
            "VALIDATION_ERROR",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match set_track_favorite(db, &auth.user.id, &track_id, false).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

async fn get_favorite_albums_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match list_favorite_albums(db, &auth.user.id).await {
        Ok(albums) => Json(json!({ "albums": albums })).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

async fn put_media_favorite_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path((item_type, item_id)): Path<(String, String)>,
    payload_res: Result<Json<MediaFavoritePutBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !matches!(item_type.as_str(), "album" | "artist" | "track") || item_id.trim().is_empty() {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid favorite item type or ID",
            "VALIDATION_ERROR",
        );
    }

    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid favorite payload",
            "VALIDATION_ERROR",
        );
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match set_media_favorite(
        db,
        &auth.user.id,
        &item_type,
        &item_id,
        body.liked,
        body.metadata.as_ref(),
    )
    .await
    {
        Ok(()) => Json(json!({ "ok": true, "liked": body.liked })).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

async fn get_recently_played_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let taste_only = params.get("tasteOnly").is_some_and(|v| v == "1");
    match list_recently_played_entries(db, &auth.user.id, taste_only).await {
        Ok(entries) => Json(json!({ "tracks": entries })).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

async fn post_recently_played_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<RecentlyPlayedPostBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid recently played request",
            "VALIDATION_ERROR",
        );
    };

    let track_id = body.track_id.trim();
    if track_id.is_empty() || track_id.contains('/') {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid recently played request",
            "VALIDATION_ERROR",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match add_recently_played(db, &auth.user.id, track_id, None, false, None, None).await {
        Ok(_) => (StatusCode::CREATED, Json(json!({ "ok": true }))).into_response(),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

// ============================================================================
// Listening Activity & Analytics Handlers
// ============================================================================

async fn post_listening_event_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<PlaybackEventInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(event)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid playback event payload",
            "VALIDATION_ERROR",
        );
    };

    if event
        .owner_user_id
        .as_ref()
        .is_some_and(|owner| owner != &auth.user.id)
    {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "Playback report belongs to a different signed-in user",
            "USER_MISMATCH",
        );
    }

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match record_playback_with_scrobbles(db, &auth.user.id, &event, Some(state.scrobble_queue()))
        .await
    {
        Ok(outcome) => Json(outcome).into_response(),
        Err(ListeningActivityError::Validation(msg)) => {
            send_error_response(StatusCode::BAD_REQUEST, msg, "VALIDATION_ERROR")
        }
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn get_listening_activity_config_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match listening_threshold(db).await {
        Ok(threshold) => Json(json!({ "thresholdSeconds": threshold })).into_response(),
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn get_listening_activity_history_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let period_str = params.get("period").map_or("all", String::as_str);
    let Ok(period) = ActivityPeriod::parse_str(period_str) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid history query",
            "VALIDATION_ERROR",
        );
    };

    let search = params.get("search").cloned().unwrap_or_default();
    if search.chars().count() > 200 {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid history query",
            "VALIDATION_ERROR",
        );
    }

    let limit = if let Some(raw_limit) = params.get("limit") {
        let Ok(parsed) = raw_limit.parse::<usize>() else {
            return send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid history query",
                "VALIDATION_ERROR",
            );
        };
        if !(1..=50).contains(&parsed) {
            return send_error_response(
                StatusCode::BAD_REQUEST,
                "Invalid history query",
                "VALIDATION_ERROR",
            );
        }
        parsed
    } else {
        30
    };

    let cursor = if let Some(raw_cursor) = params.get("cursor") {
        match HistoryCursor::decode(raw_cursor) {
            Ok(c) => Some(c),
            Err(_) => {
                return send_error_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid history cursor",
                    "VALIDATION_ERROR",
                );
            }
        }
    } else {
        None
    };

    match listening_history(db, &auth.user.id, period, &search, limit, cursor.as_ref()).await {
        Ok(res) => Json(res).into_response(),
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn get_listening_activity_statistics_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    let period_str = params.get("period").map_or("all", String::as_str);
    let Ok(period) = ActivityPeriod::parse_str(period_str) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid statistics period",
            "VALIDATION_ERROR",
        );
    };

    match listening_statistics(db, &auth.user.id, period).await {
        Ok(stats) => Json(stats).into_response(),
        Err(err) => ServerError::Internal(err.to_string()).into_response(),
    }
}

async fn get_album_artwork_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(album_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, resolver, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };

    let candidates = resolver.candidate_sources(&album_id, None).await;
    for candidate in candidates {
        if let Ok(Some(album)) = candidate
            .provider
            .provider
            .get_album(&candidate.source.provider_item_id)
            .await
            && let Ok(stamped) = catalog
                .stamp_album(album, &candidate.source.connection_id)
                .await
            && let Some(art_id) = stamped.item.artwork_id
        {
            return fetch_artwork_handler(State(state), auth, Path(art_id), Query(params)).await;
        }
    }

    fetch_artwork_handler(State(state), auth, Path(album_id), Query(params)).await
}

async fn list_tracks_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok());
    let offset = params
        .get("offset")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

    let res = catalog.list_tracks().await;
    let total = res.items.len();
    let tracks: Vec<_> = match limit {
        Some(lim) => res.items.into_iter().skip(offset).take(lim.clamp(1, 500)).collect(),
        None => res.items,
    };

    Json(json!({
        "tracks": tracks,
        "total": total,
        "offset": offset,
        "degraded": res.degraded,
    }))
    .into_response()
}

async fn list_recently_added_tracks_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);

    let mut res = catalog.list_tracks().await;
    res.items.sort_by(|a, b| b.item.added_at.cmp(&a.item.added_at));
    res.items.truncate(limit);

    Json(json!({
        "tracks": res.items,
        "degraded": res.degraded,
    }))
    .into_response()
}

async fn get_random_albums_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = params
        .get("limit")
        .or_else(|| params.get("size"))
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(12)
        .clamp(1, 100);

    match catalog.list_albums(Some(u32::try_from(limit).unwrap_or(12))).await {
        Ok(res) => Json(json!({
            "albums": res.items,
            "degraded": res.degraded,
        }))
        .into_response(),
        Err(err) => send_error_response(StatusCode::BAD_GATEWAY, err.to_string(), "BACKEND_ERROR"),
    }
}

async fn get_random_tracks_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = params
        .get("limit")
        .or_else(|| params.get("size"))
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);

    let mut res = catalog.list_tracks().await;
    res.items.truncate(limit);
    Json(json!({
        "tracks": res.items,
        "degraded": res.degraded,
    }))
    .into_response()
}

async fn post_filter_tracks_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Json(body): Json<Value>,
) -> Response {
    let (catalog, _, _) = match build_catalog_and_resolver(&state) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let limit = body
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(100)
        .clamp(1, 500);
    let mut res = catalog.list_tracks().await;
    res.items.truncate(limit);
    Json(json!({
        "tracks": res.items,
        "total": res.items.len(),
        "degraded": res.degraded,
    }))
    .into_response()
}

async fn post_library_matches_handler(
    _auth: AuthenticatedUser,
) -> Response {
    Json(json!({ "matches": {} })).into_response()
}
