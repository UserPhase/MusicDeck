//! # Saved Discoveries, External Charts & External Artwork Proxy Routes (`routes::external_discovery`)
//!
//! Complete Rust port of `server/src/routes/saved-discoveries.ts` plus external
//! discovery and artwork proxy endpoints from `server/src/routes/music-routes.ts`.

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde_json::json;

use crate::auth::AuthenticatedUser;
use crate::catalog::CatalogService;
use crate::db::DbPool;
use crate::error::ServerError;
use crate::external::{
    SaveDiscoveryInput, delete_saved_discovery, list_saved_discoveries, save_discovery,
};
use crate::state::AppState;
use crate::streaming::send_error_response;

/// Body limit (`64 KiB`) for `POST /api/v1/discoveries/save`.
pub const MAX_SAVED_DISCOVERY_BODY_BYTES: usize = 65_536;

/// Registers `/api/v1/discoveries/*`, `/api/discovery/external`, and `/api/artwork/external/:artwork_id`.
pub fn external_discovery_routes() -> Router<AppState> {
    let save_route = Router::new()
        .route("/api/v1/discoveries/save", post(post_save_discovery_handler))
        .layer(DefaultBodyLimit::max(MAX_SAVED_DISCOVERY_BODY_BYTES));

    Router::new()
        .route(
            "/api/v1/discoveries/saved",
            get(get_saved_discoveries_handler),
        )
        .route(
            "/api/v1/discoveries/saved/:id",
            delete(delete_saved_discovery_handler),
        )
        .route(
            "/api/discovery/external",
            get(get_external_discovery_charts_handler),
        )
        .route(
            "/api/discovery/itunes-preview",
            get(get_itunes_preview_handler),
        )
        .route(
            "/api/discovery/external/previews",
            post(post_external_previews_handler),
        )
        .route(
            "/api/artwork/external/:artwork_id",
            get(get_external_artwork_proxy_handler),
        )
        .route(
            "/api/tracks/:track_id/lyrics",
            get(get_track_lyrics_handler),
        )
        .route(
            "/api/tracks/:track_id/lyrics/report",
            post(post_track_lyrics_report_handler),
        )
        .route(
            "/api/metadata/artist-biography",
            get(get_artist_biography_handler),
        )
        .route(
            "/api/tracks/:track_id/artist-biography",
            get(get_track_artist_biography_handler),
        )
        .route(
            "/api/metadata/album-artwork",
            get(get_metadata_album_artwork_handler),
        )
        .route(
            "/api/artists/:artist_id/overview",
            get(get_artist_overview_handler),
        )
        .route(
            "/api/artists/:artist_id/discography",
            get(get_artist_discography_handler),
        )
        .route(
            "/api/artists/:artist_id/portrait",
            get(get_artist_portrait_handler),
        )
        .route(
            "/api/artists/:artist_id/portrait/musicbrainz",
            get(get_artist_portrait_mb_handler),
        )
        .route(
            "/api/artists/:artist_id/portrait/purge",
            post(post_artist_portrait_purge_handler),
        )
        .merge(save_route)
}

fn require_db(state: &AppState) -> Result<&DbPool, ServerError> {
    state
        .db()
        .ok_or_else(|| ServerError::Internal(String::from("Database pool is not initialized")))
}

fn with_no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

/// `POST /api/v1/discoveries/save`
async fn post_save_discovery_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    payload_res: Result<Json<SaveDiscoveryInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = payload_res else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid saved discovery",
            "VALIDATION_ERROR",
        );
    };

    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match save_discovery(db, &auth.user.id, input).await {
        Ok((created_new, record)) => {
            let status = if created_new {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(json!({ "discovery": record }))).into_response()
        }
        Err(msg) => send_error_response(StatusCode::BAD_REQUEST, msg, "VALIDATION_ERROR"),
    }
}

/// `DELETE /api/v1/discoveries/saved/:id`
async fn delete_saved_discovery_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(id): Path<String>,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match delete_saved_discovery(db, &auth.user.id, &id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => send_error_response(
            StatusCode::NOT_FOUND,
            "Saved discovery not found",
            "NOT_FOUND",
        ),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

/// `GET /api/v1/discoveries/saved`
async fn get_saved_discoveries_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    let Ok(db) = require_db(&state) else {
        return ServerError::Internal(String::from("Database unavailable")).into_response();
    };

    match list_saved_discoveries(db, &auth.user.id).await {
        Ok(discoveries) => with_no_store(
            Json(json!({
                "discoveries": discoveries,
                "warning": serde_json::Value::Null,
            }))
            .into_response(),
        ),
        Err(err) => ServerError::Database(err).into_response(),
    }
}

/// `GET /api/discovery/external`
async fn get_external_discovery_charts_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
) -> Response {
    if !auth.user.is_admin() && !auth.user.external_search_enabled {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "External catalog is not available for this user",
            "FORBIDDEN",
        );
    }

    match state.deezer_discovery().get_charts().await {
        Ok(charts) => Json(charts).into_response(),
        Err(err) => send_error_response(StatusCode::BAD_GATEWAY, err.to_string(), "BACKEND_ERROR"),
    }
}

/// `GET /api/artwork/external/:artwork_id`
async fn get_external_artwork_proxy_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artwork_id): Path<String>,
) -> Response {
    if !auth.user.is_admin() && !auth.user.external_search_enabled {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "External catalog is not available for this user",
            "FORBIDDEN",
        );
    }

    let Some(cdn_url) = state.artwork_tokens().resolve(&artwork_id) else {
        return send_error_response(StatusCode::NOT_FOUND, "Artwork not found", "NOT_FOUND");
    };

    let Ok(upstream) = reqwest::get(&cdn_url).await else {
        return send_error_response(StatusCode::BAD_GATEWAY, "Artwork unavailable", "BACKEND_ERROR");
    };

    if !upstream.status().is_success() {
        return send_error_response(StatusCode::BAD_GATEWAY, "Artwork unavailable", "BACKEND_ERROR");
    }

    let ct = upstream
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !matches!(
        ct.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return send_error_response(StatusCode::BAD_GATEWAY, "Artwork unavailable", "BACKEND_ERROR");
    }

    let Ok(bytes) = upstream.bytes().await else {
        return send_error_response(StatusCode::BAD_GATEWAY, "Artwork unavailable", "BACKEND_ERROR");
    };

    let mut res = (StatusCode::OK, bytes).into_response();
    if let Ok(ct_val) = HeaderValue::from_str(&ct) {
        res.headers_mut().insert(CONTENT_TYPE, ct_val);
    }
    res.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    res
}

async fn get_itunes_preview_handler(
    _auth: AuthenticatedUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(term) = params.get("term").map(|s| s.trim()).filter(|s| !s.is_empty() && s.len() <= 300) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid preview lookup",
            "VALIDATION_ERROR",
        );
    };
    let mut url = url::Url::parse("https://itunes.apple.com/search").expect("valid itunes url");
    url.query_pairs_mut()
        .append_pair("term", term)
        .append_pair("entity", "song")
        .append_pair("limit", "1");

    let Ok(res) = reqwest::get(url).await else {
        return send_error_response(
            StatusCode::BAD_GATEWAY,
            "iTunes preview lookup unavailable",
            "BACKEND_ERROR",
        );
    };
    if !res.status().is_success() {
        return send_error_response(
            StatusCode::BAD_GATEWAY,
            "iTunes preview lookup unavailable",
            "BACKEND_ERROR",
        );
    }
    let Ok(payload) = res.json::<serde_json::Value>().await else {
        return send_error_response(
            StatusCode::BAD_GATEWAY,
            "iTunes preview lookup unavailable",
            "BACKEND_ERROR",
        );
    };
    with_no_store(Json(payload).into_response())
}

async fn post_external_previews_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(tracks_arr) = body.get("tracks").and_then(serde_json::Value::as_array) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid external preview lookup request",
            "VALIDATION_ERROR",
        );
    };

    let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 5);
    let mut out = Vec::with_capacity(tracks_arr.len());

    for tr in tracks_arr.iter().take(20) {
        let id = tr.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
        let existing_preview = tr
            .get("previewUrl")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if existing_preview.is_some() {
            out.push(json!({ "id": id, "previewUrl": existing_preview }));
            continue;
        }
        let title = tr.get("title").and_then(serde_json::Value::as_str).unwrap_or_default();
        let artist = tr.get("artist").and_then(serde_json::Value::as_str).unwrap_or_default();
        let query = format!("{artist} {title}").trim().to_owned();
        let mut resolved = None;
        if !query.is_empty() {
            if let Ok(found) = crate::external::ExternalProvider::search_tracks(&deezer, &query).await {
                resolved = found.into_iter().find_map(|item| item.preview_url);
            }
        }
        out.push(json!({ "id": id, "previewUrl": resolved }));
    }

    Json(json!({ "tracks": out })).into_response()
}

async fn get_track_lyrics_handler(
    State(state): State<AppState>,
    _auth: AuthenticatedUser,
    Path(track_id): Path<String>,
) -> Response {
    let Some(pool) = state.db() else {
        return send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable",
            "BACKEND_ERROR",
        );
    };
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());
    let Some(track) = catalog.get_track(&track_id).await else {
        return send_error_response(StatusCode::NOT_FOUND, "Track not found", "NOT_FOUND");
    };
    let result = state
        .lyrics()
        .get_lyrics(&crate::external::LyricsTrackQuery {
            title: track.item.title.clone(),
            artist: track.item.artist_name.clone(),
            album: Some(track.item.album_name.clone()),
            duration_seconds: f64::from(track.item.duration_seconds.unwrap_or(0)),
        })
        .await;
    Json(result).into_response()
}

async fn post_track_lyrics_report_handler(
    _auth: AuthenticatedUser,
    Path(_track_id): Path<String>,
) -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn get_artist_biography_handler(
    _auth: AuthenticatedUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(artist_name) = params.get("artist").map(|s| s.trim()).filter(|s| !s.is_empty() && s.len() <= 200) else {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid artist metadata request",
            "VALIDATION_ERROR",
        );
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("MusicDeck/0.1.0 (https://github.com/UserPhase/MusicDeck)")
        .build()
        .unwrap_or_default();

    let candidates = [
        format!("{artist_name} (musician)"),
        format!("{artist_name} (band)"),
        artist_name.to_owned(),
    ];

    for title_query in candidates {
        let slug = title_query.replace(' ', "_");
        let encoded = urlencoding::encode(&slug);
        let url = format!("https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}");
        let Ok(res) = client.get(&url).send().await else {
            continue;
        };
        if !res.status().is_success() {
            continue;
        }
        let Ok(payload) = res.json::<serde_json::Value>().await else {
            continue;
        };
        if payload.get("type").and_then(serde_json::Value::as_str) == Some("disambiguation") {
            continue;
        }
        let Some(extract) = payload
            .get("extract")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        let page_url = payload
            .get("content_urls")
            .and_then(|c| c.get("desktop"))
            .and_then(|d| d.get("page"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("https://en.wikipedia.org");

        return Json(serde_json::json!({
            "biography": {
                "text": extract,
                "url": page_url,
            }
        }))
        .into_response();
    }

    Json(serde_json::json!({ "biography": null })).into_response()
}

async fn get_track_artist_biography_handler(
    _auth: AuthenticatedUser,
    Path(_track_id): Path<String>,
) -> Response {
    Json(serde_json::json!({ "biography": null })).into_response()
}

async fn get_metadata_album_artwork_handler(
    _auth: AuthenticatedUser,
) -> Response {
    Json(serde_json::json!({ "artworkUrl": null })).into_response()
}

async fn resolve_external_artist_detail(
    state: &AppState,
    artist_id: &str,
) -> Option<serde_json::Value> {
    if artist_id.starts_with("external_itunes_artist_") {
        let itunes = crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 25);
        itunes.get_artist(artist_id).await
    } else {
        let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 25);
        deezer.get_artist(artist_id).await
    }
}

async fn local_artist_sources(
    state: &AppState,
    pool: &DbPool,
    artist_id: &str,
) -> Vec<(crate::providers::RegisteredProvider, String)> {
    let resolver = crate::catalog::SourceResolver::new(
        state.providers().clone(),
        crate::catalog::LibraryService::new(pool.clone(), None),
    );

    let mut targets: Vec<(crate::providers::RegisteredProvider, String)> = resolver
        .candidate_sources(artist_id, None)
        .await
        .into_iter()
        .map(|c| (c.provider, c.source.provider_item_id))
        .collect();

    if targets.is_empty() && !artist_id.starts_with("md_") {
        for p in state.providers().list() {
            if p.enabled {
                targets.push((p, artist_id.to_owned()));
            }
        }
    }
    targets
}

async fn resolve_local_artist_snapshot(
    state: &AppState,
    pool: &DbPool,
    artist_id: &str,
) -> Option<(
    crate::catalog::Available<crate::providers::Artist>,
    Vec<crate::catalog::Available<crate::providers::Album>>,
    Vec<crate::catalog::Available<crate::providers::Track>>,
)> {
    let catalog = CatalogService::from_pool(pool.clone(), state.providers().clone());

    for (prov, prov_artist_id) in local_artist_sources(state, pool, artist_id).await {
        let (artist_res, albums_res, top_res) = tokio::join!(
            prov.provider.get_artist(&prov_artist_id, false),
            prov.provider.get_artist_albums(&prov_artist_id),
            prov.provider.get_artist_top_tracks(&prov_artist_id, 10)
        );
        let Ok(Some(raw_artist)) = artist_res else {
            continue;
        };
        let Ok(stamped_artist) = catalog.stamp_artist(raw_artist, &prov.connection_id).await else {
            continue;
        };

        let mut stamped_albums = Vec::new();
        if let Ok(albums) = albums_res {
            for alb in albums {
                if let Ok(sa) = catalog.stamp_album(alb, &prov.connection_id).await {
                    stamped_albums.push(sa);
                }
            }
        }

        let mut stamped_tracks = Vec::new();
        let raw_tracks = match top_res {
            Ok(list) if !list.is_empty() => list,
            _ => prov
                .provider
                .get_artist_tracks(&prov_artist_id)
                .await
                .unwrap_or_default(),
        };
        for tr in raw_tracks {
            if let Ok(st) = catalog.stamp_track(tr, &prov.connection_id).await {
                stamped_tracks.push(st);
            }
        }

        return Some((stamped_artist, stamped_albums, stamped_tracks));
    }

    None
}

async fn find_external_artist_by_name(
    state: &AppState,
    artist_name: &str,
) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    let target_key = crate::catalog::normalize_music_text(Some(artist_name));
    if target_key.is_empty() {
        return (None, None);
    }

    let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 8);
    let itunes = crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 8);

    let (dz_candidates, it_candidates) = tokio::join!(
        crate::external::ExternalProvider::search_artists(&deezer, artist_name),
        crate::external::ExternalProvider::search_artists(&itunes, artist_name)
    );

    let dz_id = dz_candidates.ok().and_then(|list| {
        list.into_iter()
            .find(|c| crate::catalog::normalize_music_text(Some(&c.title)) == target_key)
            .map(|c| c.id)
    });
    let it_id = it_candidates.ok().and_then(|list| {
        list.into_iter()
            .find(|c| crate::catalog::normalize_music_text(Some(&c.title)) == target_key)
            .map(|c| c.id)
    });

    tokio::join!(
        async {
            match dz_id {
                Some(id) => deezer.get_artist(&id).await,
                None => None,
            }
        },
        async {
            match it_id {
                Some(id) => itunes.get_artist(&id).await,
                None => None,
            }
        }
    )
}

async fn get_artist_overview_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let external_allowed = (auth.user.is_admin() || auth.user.external_search_enabled)
        && state
            .privacy()
            .is_external_allowed(crate::services::privacy::ExternalCategory::Metadata);

    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        let keyless = artist_id.starts_with("external_deezer_artist_")
            || artist_id.starts_with("external_itunes_artist_");
        if !keyless && !external_allowed {
            return send_error_response(
                StatusCode::FORBIDDEN,
                "External catalog is not available for this user",
                "FORBIDDEN",
            );
        }
        if let Some(artist) = resolve_external_artist_detail(&state, &artist_id).await {
            let albums = artist.get("albums").cloned().unwrap_or_else(|| json!([]));
            let tracks_arr = artist
                .get("tracks")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let top_10: Vec<_> = tracks_arr.into_iter().take(10).collect();
            return Json(serde_json::json!({
                "artist": artist,
                "albums": albums,
                "tracks": top_10,
                "topTracks": top_10,
                "localAlbumCount": 0,
                "localSongCount": 0,
            }))
            .into_response();
        }
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    }

    let Some(pool) = state.db() else {
        return send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable",
            "BACKEND_ERROR",
        );
    };

    let Some((stamped_artist, local_albums, local_tracks)) =
        resolve_local_artist_snapshot(&state, pool, &artist_id).await
    else {
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    };

    let scope = params.get("scope").map(String::as_str);
    let local_song_count: u32 = local_albums.iter().map(|a| a.item.song_count).sum();
    let local_album_count = local_albums.len();

    let mut albums_json: Vec<serde_json::Value> = local_albums
        .iter()
        .filter_map(|a| serde_json::to_value(a).ok())
        .collect();
    let local_tracks_top: Vec<serde_json::Value> = local_tracks
        .iter()
        .take(10)
        .filter_map(|t| serde_json::to_value(t).ok())
        .collect();
    let mut popular_top = local_tracks_top.clone();

    if external_allowed && scope != Some("local") {
        let (dz_detail, it_detail) =
            find_external_artist_by_name(&state, &stamped_artist.item.name).await;
        let mut seen_album_keys: std::collections::HashSet<String> = local_albums
            .iter()
            .map(|a| crate::catalog::normalize_music_text(Some(&a.item.name)))
            .collect();

        for ext_detail in [it_detail.as_ref(), dz_detail.as_ref()].into_iter().flatten() {
            if let Some(arr) = ext_detail.get("albums").and_then(serde_json::Value::as_array) {
                for alb in arr {
                    let title = alb
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let key = crate::catalog::normalize_music_text(Some(title));
                    if !key.is_empty() && seen_album_keys.insert(key) {
                        let mut enriched = alb.clone();
                        enriched["artist"] = json!(stamped_artist.item.name);
                        enriched["artistId"] = json!(stamped_artist.item.id);
                        albums_json.push(enriched);
                    }
                }
            }
        }

        let mut seen_track_keys: std::collections::HashSet<String> = local_tracks
            .iter()
            .map(|t| crate::catalog::normalize_music_text(Some(&t.item.title)))
            .collect();
        for ext_detail in [it_detail.as_ref(), dz_detail.as_ref()].into_iter().flatten() {
            if let Some(arr) = ext_detail.get("tracks").and_then(serde_json::Value::as_array) {
                for tr in arr {
                    if popular_top.len() >= 10 {
                        break;
                    }
                    let title = tr
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let key = crate::catalog::normalize_music_text(Some(title));
                    if !key.is_empty() && seen_track_keys.insert(key) {
                        popular_top.push(tr.clone());
                    }
                }
            }
        }
    }

    let mut artist_val = serde_json::to_value(&stamped_artist).unwrap_or_else(|_| json!({}));
    artist_val["imageUrl"] = serde_json::Value::Null;

    Json(serde_json::json!({
        "artist": artist_val,
        "albums": albums_json,
        "tracks": local_tracks_top,
        "topTracks": popular_top,
        "localAlbumCount": local_album_count,
        "localSongCount": local_song_count,
        "externalEnrichmentAvailable": scope == Some("local") && external_allowed,
    }))
    .into_response()
}

async fn get_artist_discography_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Response {
    let external_allowed = (auth.user.is_admin() || auth.user.external_search_enabled)
        && state
            .privacy()
            .is_external_allowed(crate::services::privacy::ExternalCategory::Metadata);
    if !external_allowed {
        return send_error_response(
            StatusCode::FORBIDDEN,
            "External catalog is not available for this user",
            "FORBIDDEN",
        );
    }

    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        return send_error_response(
            StatusCode::BAD_REQUEST,
            "Complete discography requires a local artist",
            "BAD_REQUEST",
        );
    }

    let Some(pool) = state.db() else {
        return send_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable",
            "BACKEND_ERROR",
        );
    };

    let Some((stamped_artist, local_albums, local_tracks)) =
        resolve_local_artist_snapshot(&state, pool, &artist_id).await
    else {
        return send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND");
    };

    let (dz_detail, it_detail) =
        find_external_artist_by_name(&state, &stamped_artist.item.name).await;

    let mut seen_album_keys: std::collections::HashSet<String> = local_albums
        .iter()
        .map(|a| crate::catalog::normalize_music_text(Some(&a.item.name)))
        .collect();
    let mut missing_albums = Vec::new();

    for (provider_name, detail_opt) in [("itunes", &it_detail), ("deezer", &dz_detail)] {
        if let Some(detail) = detail_opt {
            if let Some(arr) = detail.get("albums").and_then(serde_json::Value::as_array) {
                for alb in arr {
                    let title = alb
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let key = crate::catalog::normalize_music_text(Some(title));
                    if key.is_empty() || !seen_album_keys.insert(key) {
                        continue;
                    }
                    let id = alb
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let year = alb.get("year").and_then(serde_json::Value::as_i64);
                    let artwork_id = alb.get("artworkId").and_then(serde_json::Value::as_str);
                    missing_albums.push(json!({
                        "id": id,
                        "title": title,
                        "name": title,
                        "artist": stamped_artist.item.name,
                        "year": year,
                        "artworkId": artwork_id,
                        "coverArt": artwork_id,
                        "provider": provider_name,
                        "source": { "kind": "external", "count": 0, "externalAvailable": true },
                        "discographySource": "external",
                    }));
                }
            }
        }
    }

    let mut seen_track_keys: std::collections::HashSet<String> = local_tracks
        .iter()
        .map(|t| crate::catalog::normalize_music_text(Some(&t.item.title)))
        .collect();
    let mut missing_tracks = Vec::new();

    for (provider_name, detail_opt) in [("itunes", &it_detail), ("deezer", &dz_detail)] {
        if let Some(detail) = detail_opt {
            if let Some(arr) = detail.get("tracks").and_then(serde_json::Value::as_array) {
                for tr in arr {
                    let title = tr
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let key = crate::catalog::normalize_music_text(Some(title));
                    if key.is_empty() || !seen_track_keys.insert(key) {
                        continue;
                    }
                    let mut item = tr.clone();
                    item["coverArt"] = tr.get("artworkId").cloned().unwrap_or(serde_json::Value::Null);
                    item["provider"] = json!(provider_name);
                    item["source"] = json!({ "kind": "external", "count": 0, "externalAvailable": true });
                    item["discographySource"] = json!("external");
                    missing_tracks.push(item);
                }
            }
        }
    }

    Json(serde_json::json!({
        "missingAlbums": missing_albums,
        "missingTracks": missing_tracks,
        "providers": {
            "itunes": it_detail.is_some(),
            "deezer": dz_detail.is_some(),
        }
    }))
    .into_response()
}

async fn get_artist_portrait_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    if artist_id.starts_with("external_") || artist_id.starts_with("extdetail_") {
        return with_no_store(Json(serde_json::json!({ "imageUrl": null })).into_response());
    }
    let Some(pool) = state.db() else {
        return with_no_store(Json(serde_json::json!({ "imageUrl": null })).into_response());
    };
    let skip_native = params.get("skipNative").map(String::as_str) == Some("1");
    let skip_deezer = params.get("skipDeezer").map(String::as_str) == Some("1");
    let artwork_allowed = artist_external_artwork_allowed(&state, &auth);
    let resolver = crate::catalog::LibraryService::new(pool.clone(), None);
    for (provider, id) in local_artist_sources(&state, pool, &artist_id).await {
        // Top tracks can trigger external work in Navidrome. A portrait only needs
        // the artist record and its local albums to rule out an album cover.
        let (artist, albums) = tokio::join!(
            provider.provider.get_artist(&id, artwork_allowed && !skip_native),
            provider.provider.get_artist_albums(&id),
        );
        let Ok(Some(artist)) = artist else { continue };
        let albums = albums.unwrap_or_default();
        if !skip_native {
            if let Some(art_id) = artist.artwork_id.as_deref().filter(|art_id| {
                !albums.iter().any(|album| album.artwork_id.as_deref() == Some(*art_id))
            }) && let Ok(id) = resolver.ensure_artwork_id(&crate::catalog::SourceRef {
                connection_id: provider.connection_id,
                provider_item_id: art_id.to_owned(),
            }).await {
                return artist_portrait(crate::providers::format_artwork_url(Some(&id)), "native", "artist");
            }
            if let Some(url) = artist.image_url.filter(|url| {
                artwork_allowed && url.starts_with("https://") &&
                    !albums.iter().any(|album| album.artwork_url.as_ref() == Some(url))
            }) {
                return artist_portrait(Some(url), "native", "artist");
            }
        }
        if artwork_allowed {
            if !skip_deezer && let Some(url) = deezer_artist_portrait(&state, &artist.name, &albums).await {
                return artist_portrait(Some(url), "deezer", "artist");
            }
            if let Some(url) = itunes_artist_tile(&state, &artist.name, &albums).await {
                return artist_portrait(Some(url), "itunes", "artist-tile-fallback");
            }
        }
        return artist_portrait(None, "native", "artist");
    }
    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

fn artist_external_artwork_allowed(state: &AppState, auth: &AuthenticatedUser) -> bool {
    (auth.user.is_admin() || auth.user.external_search_enabled)
        && state.privacy().is_external_allowed(crate::services::privacy::ExternalCategory::Artwork)
}

fn artist_portrait(url: Option<String>, source: &str, kind: &str) -> Response {
    with_no_store(Json(json!({
        "imageSource": url.as_ref().map(|_| source),
        "imageKind": url.as_ref().map(|_| kind),
        "imageUrl": url,
    })).into_response())
}

fn exact_artist_candidates(
    candidates: Vec<crate::external::ExternalSearchItem>, name: &str,
) -> impl Iterator<Item = crate::external::ExternalSearchItem> {
    let name = crate::catalog::normalize_music_text(Some(name));
    candidates.into_iter().filter(move |candidate| {
        !name.is_empty() && crate::catalog::normalize_music_text(Some(&candidate.title)) == name
    })
}

fn matching_artist_albums<'a>(detail: &'a serde_json::Value, albums: &[crate::providers::Album]) -> impl Iterator<Item = &'a serde_json::Value> {
    let album_key = |title: &str| (
        crate::catalog::normalize_music_text(Some(title)),
        crate::catalog::version_signature(Some(title)),
    );
    let local_titles: std::collections::HashSet<_> = albums.iter().map(|album| album_key(&album.name)).collect();
    detail.get("albums").and_then(serde_json::Value::as_array).into_iter().flatten()
        .filter(move |album| album.get("title").and_then(serde_json::Value::as_str)
            .is_some_and(|title| local_titles.contains(&album_key(title))))
}

async fn deezer_artist_portrait(state: &AppState, name: &str, albums: &[crate::providers::Album]) -> Option<String> {
    use crate::external::ExternalProvider as _;
    let deezer = crate::external::DeezerAdapter::new(state.artwork_tokens().clone(), 8);
    let mut candidates: Vec<_> = exact_artist_candidates(deezer.search_artists(name).await.ok()?, name).collect();
    let unique = candidates.len() == 1;
    candidates.truncate(3);
    let mut best_match = None;
    let mut best_score = 0;
    for candidate in candidates {
        let Some(artwork) = candidate.artwork else { continue };
        let Some(url) = state.artwork_tokens().resolve(&artwork.id).and_then(|url| url::Url::parse(&url).ok()) else { continue };
        if !url.path().starts_with("/images/artist/") || url.path().contains("2a96cbd8b46e442fc41c2b86b821562f") {
            continue;
        }
        if unique { return Some(artwork.url); }
        if albums.is_empty() { return None }
        let Some(detail) = deezer.get_artist(&candidate.id).await else { continue };
        let score = matching_artist_albums(&detail, albums).count();
        if score > best_score {
            best_score = score;
            best_match = Some(artwork.url);
        } else if score == best_score {
            best_match = None;
        }
    }
    best_match
}

async fn itunes_artist_tile(state: &AppState, name: &str, albums: &[crate::providers::Album]) -> Option<String> {
    use crate::external::ExternalProvider as _;
    if albums.is_empty() { return None }
    let itunes = crate::external::ItunesAdapter::new(state.artwork_tokens().clone(), 8);
    let mut candidates = exact_artist_candidates(itunes.search_artists(name).await.ok()?, name);
    let candidate = candidates.next()?;
    if candidates.next().is_some() { return None }
    let detail = itunes.get_artist(&candidate.id).await?;
    matching_artist_albums(&detail, albums).find_map(|album| {
        album.get("artworkUrl").and_then(serde_json::Value::as_str).map(str::to_owned)
    })
}

async fn get_artist_portrait_mb_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Response {
    use crate::external::artist_portrait::{resolve_musicbrainz_portrait, valid_commons_image};
    let missing = || artist_portrait(None, "musicbrainz", "artist");
    if !artist_external_artwork_allowed(&state, &auth)
        || artist_id.starts_with("external_") || artist_id.starts_with("extdetail_")
    {
        return missing();
    }
    let Some(pool) = state.db() else { return missing() };
    for (provider, id) in local_artist_sources(&state, pool, &artist_id).await {
        let Ok(Some(artist)) = provider.provider.get_artist(&id, false).await else { continue };
        let key = format!("artist_avatar_mb:{artist_id}");
        let cached = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
            .bind(&key).fetch_optional(pool.inner()).await.ok().flatten()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
        if let Some(url) = cached.as_ref().filter(|entry| entry["name"].as_str() == Some(&artist.name))
            .and_then(|entry| entry["url"].as_str()).filter(|url| valid_commons_image(url))
        {
            return artist_portrait(Some(url.to_owned()), "musicbrainz", "artist");
        }
        let url = tokio::time::timeout(std::time::Duration::from_secs(12), resolve_musicbrainz_portrait(&artist))
            .await.ok().flatten();
        if let Some(url) = &url {
            let result = sqlx::query(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            ).bind(&key).bind(json!({ "url": url, "name": artist.name }).to_string()).execute(pool.inner()).await;
            if let Err(error) = result { tracing::warn!(%error, "Could not cache artist portrait"); }
        }
        return artist_portrait(url, "musicbrainz", "artist");
    }
    send_error_response(StatusCode::NOT_FOUND, "Artist not found", "NOT_FOUND")
}

async fn post_artist_portrait_purge_handler(
    State(state): State<AppState>,
    auth: AuthenticatedUser,
    Path(artist_id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    if !auth.user.is_admin() {
        return Err(ServerError::Forbidden("Admin access required".into()));
    }
    let pool = require_db(&state)?;
    sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(format!("artist_avatar_mb:{artist_id}")).execute(pool.inner()).await
        .map_err(|error| {
            tracing::error!(%error, "Could not clear artist portrait cache");
            ServerError::Internal("Could not clear artist portrait cache".into())
        })?;
    Ok(Json(json!({ "ok": true, "purged": true, "artistId": artist_id })))
}
