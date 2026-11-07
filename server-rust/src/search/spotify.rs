//! # Spotify Web API Client-Credentials Auth & Search Provider (`search::spotify`)
//!
//! Ports `server/src/domain/spotify-auth.ts` and `SpotifySearchProvider` from
//! `server/src/domain/search-provider-registry.ts`:
//! - Official Spotify Web API `client_credentials` token acquisition (`https://accounts.spotify.com/api/token`)
//! - Thread-safe token caching (`Arc<RwLock<Option<CachedSpotifyToken>>>`) with 5-second safety buffer
//! - Credential fallback to `plugin_configs WHERE plugin_id = 'spotdl-downloader'`
//! - Stage-labeled diagnostics (`"token"` vs `"catalog"`) and two-stage `test()` probe

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::db::DbPool;
use crate::search::models::{
    SearchOptions, SearchProvider, SearchProviderKind, SearchProviderTestResult,
    SearchResultMetadata, SearchResultSource, SearchResultType, UnifiedSearchResult,
};

/// Spotify Web API token endpoint.
pub const SPOTIFY_TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
/// Spotify Web API catalog search endpoint.
pub const SPOTIFY_SEARCH_URL: &str = "https://api.spotify.com/v1/search";
/// Timeout for Spotify token and catalog requests (`10,000 ms`).
pub const SPOTIFY_TIMEOUT_MS: u64 = 10_000;

/// Client-credentials pair for Spotify Web API authentication.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyCredentials {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

impl SpotifyCredentials {
    /// Returns `true` when both `client_id` and `client_secret` are non-empty.
    #[must_use]
    pub fn is_configured(&self) -> bool {
        self.client_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
            && self
                .client_secret
                .as_deref()
                .is_some_and(|secret| !secret.trim().is_empty())
    }
}

/// Diagnostic failure stage for Spotify authentication/catalog requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpotifyAuthStage {
    Token,
    Catalog,
}

/// Structured error returned by [`SpotifyAuthClient`].
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SpotifyAuthError {
    pub stage: SpotifyAuthStage,
    pub message: String,
    pub status: Option<u16>,
    pub detail: Option<String>,
}

/// Extracts a human-readable error description from a Spotify JSON or plain-text error body.
#[must_use]
pub fn describe_spotify_error_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if let Some(err_str) = parsed.get("error").and_then(Value::as_str) {
            if let Some(desc) = parsed
                .get("error_description")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                return Some(format!("{err_str}: {desc}"));
            }
            return Some(err_str.to_owned());
        }
        if let Some(msg) = parsed
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(msg.to_owned());
        }
    }

    Some(trimmed.chars().take(200).collect())
}

/// Resolves effective Spotify credentials, falling back to `spotdl-downloader` plugin config
/// in SQLite when explicit credentials are not set on the `spotify` search provider.
pub async fn resolve_spotify_credentials(
    explicit: SpotifyCredentials,
    db: Option<&DbPool>,
) -> SpotifyCredentials {
    if explicit.is_configured() {
        return explicit;
    }
    let Some(pool) = db else {
        return explicit;
    };

    let row = sqlx::query(
        "SELECT config_json FROM plugin_configs WHERE plugin_id = 'spotdl-downloader'",
    )
    .fetch_optional(pool.inner())
    .await
    .ok()
    .flatten();

    if let Some(row) = row {
        let json_str: String = row.try_get("config_json").unwrap_or_default();
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&json_str) {
            let client_id = map
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let client_secret = map
                .get("clientSecret")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let fallback = SpotifyCredentials {
                client_id,
                client_secret,
            };
            if fallback.is_configured() {
                return fallback;
            }
        }
    }

    explicit
}

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Thread-safe Spotify `client_credentials` token manager with in-memory TTL caching.
#[derive(Debug, Clone)]
pub struct SpotifyAuthClient {
    http: Client,
    cached: Arc<RwLock<Option<CachedToken>>>,
}

impl Default for SpotifyAuthClient {
    fn default() -> Self {
        Self::new()
    }
}

impl SpotifyAuthClient {
    /// Creates a new [`SpotifyAuthClient`].
    #[must_use]
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_millis(SPOTIFY_TIMEOUT_MS))
            .build()
            .unwrap_or_default();
        Self {
            http,
            cached: Arc::new(RwLock::new(None)),
        }
    }

    /// Acquires or reuses a cached bearer token for the given [`SpotifyCredentials`].
    pub async fn get_access_token(
        &self,
        credentials: &SpotifyCredentials,
    ) -> Result<Option<String>, SpotifyAuthError> {
        if !credentials.is_configured() {
            return Ok(None);
        }

        if let Ok(guard) = self.cached.read() {
            if let Some(entry) = guard.as_ref() {
                if entry.expires_at > Instant::now() + Duration::from_secs(5) {
                    return Ok(Some(entry.token.clone()));
                }
            }
        }

        let client_id = credentials.client_id.as_deref().unwrap_or_default();
        let client_secret = credentials.client_secret.as_deref().unwrap_or_default();
        let basic = BASE64_STANDARD.encode(format!("{client_id}:{client_secret}"));

        let response = self
            .http
            .post(SPOTIFY_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Authorization", format!("Basic {basic}"))
            .body("grant_type=client_credentials")
            .send()
            .await
            .map_err(|err| SpotifyAuthError {
                stage: SpotifyAuthStage::Token,
                message: format!("Could not reach accounts.spotify.com: {err}"),
                status: None,
                detail: None,
            })?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            let detail = describe_spotify_error_body(&body_text);
            let suffix = detail
                .as_deref()
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            return Err(SpotifyAuthError {
                stage: SpotifyAuthStage::Token,
                message: format!(
                    "Spotify token request failed (HTTP {}){suffix}",
                    status.as_u16()
                ),
                status: Some(status.as_u16()),
                detail,
            });
        }

        let payload: Value = response.json().await.map_err(|err| SpotifyAuthError {
            stage: SpotifyAuthStage::Token,
            message: format!("Invalid Spotify token response: {err}"),
            status: None,
            detail: None,
        })?;

        let Some(access_token) = payload
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        else {
            return Err(SpotifyAuthError {
                stage: SpotifyAuthStage::Token,
                message: String::from("Spotify token response did not include an access_token"),
                status: None,
                detail: None,
            });
        };

        let expires_in_secs = payload
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600)
            .max(30);

        if let Ok(mut guard) = self.cached.write() {
            *guard = Some(CachedToken {
                token: access_token.clone(),
                expires_at: Instant::now() + Duration::from_secs(expires_in_secs),
            });
        }

        Ok(Some(access_token))
    }
}

/// Built-in external catalog search provider backed by Spotify's official Web API.
pub struct SpotifySearchProvider {
    config: Value,
    auth: SpotifyAuthClient,
    http: Client,
    db: Option<DbPool>,
}

impl SpotifySearchProvider {
    /// Creates a new [`SpotifySearchProvider`].
    #[must_use]
    pub fn new(config: Value, db: Option<DbPool>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_millis(SPOTIFY_TIMEOUT_MS))
            .build()
            .unwrap_or_default();
        Self {
            config,
            auth: SpotifyAuthClient::new(),
            http,
            db,
        }
    }

    fn explicit_credentials(&self) -> SpotifyCredentials {
        SpotifyCredentials {
            client_id: self
                .config
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            client_secret: self
                .config
                .get("clientSecret")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

#[async_trait]
impl SearchProvider for SpotifySearchProvider {
    fn id(&self) -> &str {
        "spotify"
    }

    fn name(&self) -> &str {
        "Spotify"
    }

    async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<Vec<UnifiedSearchResult>, String> {
        let credentials =
            resolve_spotify_credentials(self.explicit_credentials(), self.db.as_ref()).await;
        if !credentials.is_configured() {
            return Ok(Vec::new());
        }

        let token = self
            .auth
            .get_access_token(&credentials)
            .await
            .map_err(|err| format!("Spotify token request failed: {}", err.message))?
            .ok_or_else(|| String::from("Spotify is unavailable: no credentials configured"))?;

        let limit = options.limit.unwrap_or(10).clamp(1, 25);
        let requested_types: Vec<&str> = [
            (SearchResultType::Track, "track"),
            (SearchResultType::Album, "album"),
            (SearchResultType::Artist, "artist"),
        ]
        .into_iter()
        .filter(|(t, _)| options.includes(*t))
        .map(|(_, label)| label)
        .collect();

        if requested_types.is_empty() {
            return Ok(Vec::new());
        }

        let response = self
            .http
            .get(SPOTIFY_SEARCH_URL)
            .query(&[
                ("q", query),
                ("type", &requested_types.join(",")),
                ("limit", &limit.to_string()),
            ])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| format!("Spotify catalog request failed: {err}"))?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            let detail = describe_spotify_error_body(&body_text);
            let suffix = detail
                .as_deref()
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            return Err(format!(
                "Spotify catalog request failed (HTTP {}){suffix}",
                status.as_u16()
            ));
        }

        let payload: Value = response
            .json()
            .await
            .map_err(|_| String::from("External catalog returned invalid data"))?;

        let mut results = Vec::new();

        if options.includes(SearchResultType::Track) {
            if let Some(items) = payload
                .get("tracks")
                .and_then(|t| t.get("items"))
                .and_then(Value::as_array)
            {
                for item in items {
                    let Some(id) = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let artist_name = item
                        .get("artists")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(|a| a.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let album_name = item
                        .get("album")
                        .and_then(|a| a.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let duration_seconds = item
                        .get("duration_ms")
                        .and_then(Value::as_u64)
                        .map(|ms| ((ms + 500) / 1000) as u32);

                    results.push(UnifiedSearchResult {
                        item_type: SearchResultType::Track,
                        id: format!("external_spotify_track_{id}"),
                        title: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown title")
                            .to_owned(),
                        subtitle: artist_name.clone(),
                        artist: artist_name,
                        artist_credits: None,
                        album: album_name,
                        artwork: None,
                        preview_url: None,
                        provider: SearchProviderKind::External,
                        source: SearchResultSource {
                            kind: String::from("external"),
                            count: 0,
                            options: None,
                            external_available: None,
                        },
                        availability: None,
                        identity: None,
                        providers: None,
                        in_library: None,
                        local_track_id: None,
                        local_album_id: None,
                        metadata: SearchResultMetadata {
                            duration_seconds,
                            ..SearchResultMetadata::default()
                        },
                        identity_hints: None,
                    });
                }
            }
        }

        if options.includes(SearchResultType::Album) {
            if let Some(items) = payload
                .get("albums")
                .and_then(|a| a.get("items"))
                .and_then(Value::as_array)
            {
                for item in items {
                    let Some(id) = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let artist_name = item
                        .get("artists")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(|a| a.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);

                    results.push(UnifiedSearchResult {
                        item_type: SearchResultType::Album,
                        id: format!("external_spotify_album_{id}"),
                        title: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown album")
                            .to_owned(),
                        subtitle: artist_name.clone(),
                        artist: artist_name,
                        artist_credits: None,
                        album: None,
                        artwork: None,
                        preview_url: None,
                        provider: SearchProviderKind::External,
                        source: SearchResultSource {
                            kind: String::from("external"),
                            count: 0,
                            options: None,
                            external_available: None,
                        },
                        availability: None,
                        identity: None,
                        providers: None,
                        in_library: None,
                        local_track_id: None,
                        local_album_id: None,
                        metadata: SearchResultMetadata::default(),
                        identity_hints: None,
                    });
                }
            }
        }

        if options.includes(SearchResultType::Artist) {
            if let Some(items) = payload
                .get("artists")
                .and_then(|a| a.get("items"))
                .and_then(Value::as_array)
            {
                for item in items {
                    let Some(id) = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown artist")
                        .to_owned();

                    results.push(UnifiedSearchResult {
                        item_type: SearchResultType::Artist,
                        id: format!("external_spotify_artist_{id}"),
                        title: name.clone(),
                        subtitle: Some(String::from("Artist")),
                        artist: Some(name),
                        artist_credits: None,
                        album: None,
                        artwork: None,
                        preview_url: None,
                        provider: SearchProviderKind::External,
                        source: SearchResultSource {
                            kind: String::from("external"),
                            count: 0,
                            options: None,
                            external_available: None,
                        },
                        availability: None,
                        identity: None,
                        providers: None,
                        in_library: None,
                        local_track_id: None,
                        local_album_id: None,
                        metadata: SearchResultMetadata::default(),
                        identity_hints: None,
                    });
                }
            }
        }

        Ok(results)
    }

    async fn test(&self) -> Result<SearchProviderTestResult, String> {
        let credentials =
            resolve_spotify_credentials(self.explicit_credentials(), self.db.as_ref()).await;
        if !credentials.is_configured() {
            return Ok(SearchProviderTestResult {
                ok: false,
                status: Some(String::from("not_configured")),
                message: Some(String::from(
                    "Spotify search is not configured — add a Client ID/Secret here or on the spotDL Downloader plugin.",
                )),
            });
        }

        // Stage 1: Token acquisition
        let token = match self.auth.get_access_token(&credentials).await {
            Ok(Some(token)) => token,
            Ok(None) => {
                return Ok(SearchProviderTestResult {
                    ok: false,
                    status: Some(String::from("authentication_failed")),
                    message: Some(String::from(
                        "Spotify authentication failed during token acquisition — check the Client ID/Secret.",
                    )),
                });
            }
            Err(err) => {
                let status = if err.status == Some(400) {
                    "authentication_failed"
                } else {
                    "provider_unavailable"
                };
                return Ok(SearchProviderTestResult {
                    ok: false,
                    status: Some(status.to_owned()),
                    message: Some(format!(
                        "Spotify authentication failed during token acquisition: {}",
                        err.message
                    )),
                });
            }
        };

        // Stage 2: Actual catalog request
        match self
            .http
            .get(SPOTIFY_SEARCH_URL)
            .query(&[("q", "test"), ("type", "track"), ("limit", "1")])
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => Ok(SearchProviderTestResult {
                ok: true,
                status: Some(String::from("success")),
                message: Some(String::from("Spotify is reachable")),
            }),
            Ok(resp) => {
                let code = resp.status().as_u16();
                let body_text = resp.text().await.unwrap_or_default();
                let detail = describe_spotify_error_body(&body_text);
                let suffix = detail
                    .as_deref()
                    .map(|d| format!(": {d}"))
                    .unwrap_or_default();
                let hint = if code == 403 {
                    " — the app's Client ID/Secret are valid, but Spotify rejected the catalog request itself. Check the app's status in the Spotify developer dashboard (e.g. Development Mode restrictions or a revoked app)."
                } else {
                    ""
                };
                let status = if code == 401 || code == 403 {
                    "authentication_failed"
                } else {
                    "provider_unavailable"
                };
                Ok(SearchProviderTestResult {
                    ok: false,
                    status: Some(status.to_owned()),
                    message: Some(format!(
                        "Spotify catalog request failed (HTTP {code}){suffix}{hint}"
                    )),
                })
            }
            Err(err) => Ok(SearchProviderTestResult {
                ok: false,
                status: Some(String::from("provider_unavailable")),
                message: Some(format!(
                    "Spotify catalog request failed — could not reach api.spotify.com: {err}"
                )),
            }),
        }
    }
}
