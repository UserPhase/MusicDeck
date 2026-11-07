//! # Last.fm Audioscrobbler 2.0 Client & MD5 Signature Generator (`scrobbling::lastfm`)
//!
//! Ports `server/src/services/scrobble/LastFmScrobbler.ts`:
//! - [`last_fm_signature`]: Signs raw UTF-8 parameter names and values sorted in
//!   lexicographical UTF-8 byte order (excluding `format`, `callback`, `api_sig`),
//!   appends the shared secret, and computes a lowercase hex MD5 digest.
//! - [`LastFmScrobbler`]:
//!   - `scrobble`: `POST https://ws.audioscrobbler.com/2.0/` (`method=track.scrobble`)
//!   - `validate_session`: `GET` (`method=user.getInfo`)
//!   - `exchange_token`: `GET` (`method=auth.getSession`)
//!   - `validate_application`: `GET` (`method=auth.getToken`)

use std::collections::BTreeMap;

use chrono::Utc;
use md5::{Digest, Md5};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scrobbling::protocol::{
    FailureKind, ScrobbleError, ScrobbleListen, build_scrobble_http_client, http_failure,
    protocol_request, retry_delay, validate_listen,
};

/// Official Last.fm Audioscrobbler 2.0 endpoint.
pub const LASTFM_ENDPOINT: &str = "https://ws.audioscrobbler.com/2.0/";

/// Computes the Last.fm API signature (`api_sig`):
/// 1. Excludes `"format"`, `"callback"`, and `"api_sig"`.
/// 2. Orders keys by raw UTF-8 byte sequence (`BTreeMap<String, String>`).
/// 3. Concatenates `<key><value>` for all remaining parameters, followed by `secret`.
/// 4. Returns the lowercase hexadecimal MD5 digest.
#[must_use]
pub fn last_fm_signature(parameters: &BTreeMap<String, String>, secret: &str) -> String {
    let mut hasher = Md5::new();
    for (key, value) in parameters {
        if matches!(key.as_str(), "format" | "callback" | "api_sig") {
            continue;
        }
        hasher.update(key.as_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(secret.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn classify_lastfm_error(code: i64) -> (&'static str, FailureKind) {
    match code {
        4 => ("Authentication failed. Reconnect Last.fm.", FailureKind::Auth),
        6 => (
            "Last.fm rejected a request parameter. Check the track metadata.",
            FailureKind::Permanent,
        ),
        9 => (
            "The Last.fm session is invalid or revoked. Reconnect Last.fm.",
            FailureKind::Auth,
        ),
        10 => (
            "The Last.fm application API key is invalid. Contact your administrator.",
            FailureKind::Configuration,
        ),
        11 => ("Last.fm is temporarily offline.", FailureKind::Transient),
        13 => (
            "Last.fm rejected the request signature. Check the application's API key and shared secret.",
            FailureKind::Configuration,
        ),
        14 => (
            "The authorization token has expired or was already used. Start authorization again.",
            FailureKind::Auth,
        ),
        15 => (
            "The Last.fm token has not been authorized. Start authorization again.",
            FailureKind::Auth,
        ),
        16 => ("Last.fm is temporarily unavailable.", FailureKind::Transient),
        26 => (
            "The Last.fm API key is suspended. Contact your administrator.",
            FailureKind::Configuration,
        ),
        29 => (
            "Last.fm's rate limit was reached. MusicDeck will retry later.",
            FailureKind::Transient,
        ),
        _ => (
            "Last.fm rejected this request. Check your account and track metadata.",
            FailureKind::Permanent,
        ),
    }
}

fn extract_xml_error_code(text: &str) -> Option<i64> {
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<lfm") || (!lower.contains("status=\"failed\"") && !lower.contains("status='failed'")) {
        return None;
    }
    let err_idx = lower.find("<error")?;
    let after_err = &lower[err_idx..];
    let code_idx = after_err.find("code=")?;
    let rest = &after_err[code_idx + 5..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let digits: String = rest[1..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok()
}

/// Credentials required to instantiate [`LastFmScrobbler`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastFmCredentials {
    pub api_key: String,
    pub api_secret: String,
    pub session_key: Option<String>,
}

/// Last.fm Audioscrobbler 2.0 client.
#[derive(Debug, Clone)]
pub struct LastFmScrobbler {
    credentials: LastFmCredentials,
    http: Client,
    endpoint: String,
}

impl LastFmScrobbler {
    /// Creates a new [`LastFmScrobbler`], verifying that `api_key` and `api_secret` are non-empty.
    pub fn new(credentials: LastFmCredentials) -> Result<Self, ScrobbleError> {
        Self::with_endpoint(credentials, LASTFM_ENDPOINT)
    }

    /// Creates a new [`LastFmScrobbler`] with a custom endpoint URL (used for testing).
    pub fn with_endpoint(
        credentials: LastFmCredentials,
        endpoint: impl Into<String>,
    ) -> Result<Self, ScrobbleError> {
        if credentials.api_key.trim().is_empty() || credentials.api_secret.trim().is_empty() {
            return Err(ScrobbleError::new(
                "APPLICATION_NOT_CONFIGURED",
                "Configure the Last.fm API key and shared secret in server plugins.",
                FailureKind::Configuration,
                None,
                0,
            ));
        }
        Ok(Self {
            credentials,
            http: build_scrobble_http_client(),
            endpoint: endpoint.into(),
        })
    }

    async fn request(
        &self,
        method: &str,
        mut parameters: BTreeMap<String, String>,
        authenticated: bool,
    ) -> Result<Value, ScrobbleError> {
        if authenticated
            && self
                .credentials
                .session_key
                .as_deref()
                .is_none_or(|sk| sk.trim().is_empty())
        {
            return Err(ScrobbleError::new(
                "NOT_CONNECTED",
                "Connect a Last.fm account first.",
                FailureKind::Auth,
                None,
                0,
            ));
        }

        parameters.insert(String::from("method"), method.to_owned());
        parameters.insert(String::from("api_key"), self.credentials.api_key.clone());
        if authenticated {
            if let Some(sk) = &self.credentials.session_key {
                parameters.insert(String::from("sk"), sk.clone());
            }
        }

        let sig = last_fm_signature(&parameters, &self.credentials.api_secret);
        parameters.insert(String::from("api_sig"), sig);
        parameters.insert(String::from("format"), String::from("json"));

        let encoded_form = parameters
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let is_write = method == "track.scrobble";
        let resp = if is_write {
            protocol_request(
                &self.http,
                Method::POST,
                &self.endpoint,
                vec![(
                    "content-type",
                    String::from("application/x-www-form-urlencoded; charset=utf-8"),
                )],
                Some(encoded_form),
            )
            .await?
        } else {
            protocol_request(
                &self.http,
                Method::GET,
                &format!("{}?{encoded_form}", self.endpoint),
                Vec::new(),
                None,
            )
            .await?
        };

        let now_ms = Utc::now().timestamp_millis();
        let json_error_code = resp
            .body
            .as_ref()
            .and_then(|b| b.get("error"))
            .and_then(Value::as_i64);
        let xml_error_code = extract_xml_error_code(&resp.text);

        if let Some(code) = json_error_code.or(xml_error_code) {
            let (msg, kind) = classify_lastfm_error(code);
            return Err(ScrobbleError::new(
                format!("LASTFM_{code}"),
                msg,
                kind,
                Some(resp.status.as_u16()),
                retry_delay(&resp.headers, now_ms),
            ));
        }

        if !resp.status.is_success() {
            return Err(http_failure(resp.status, &resp.headers, now_ms));
        }

        let Some(body) = resp.body.filter(Value::is_object) else {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "Last.fm returned an unreadable response.",
                FailureKind::Transient,
                Some(resp.status.as_u16()),
                0,
            ));
        };

        Ok(body)
    }

    /// Submits a single scrobble (`track.scrobble`) and verifies `@attr.accepted == "1"`.
    pub async fn scrobble(&self, listen: &ScrobbleListen) -> Result<(), ScrobbleError> {
        validate_listen(listen)?;
        let mut params = BTreeMap::new();
        params.insert(String::from("artist"), listen.artist.clone());
        params.insert(String::from("track"), listen.track.clone());
        params.insert(String::from("timestamp"), listen.listened_at.to_string());
        if let Some(album) = &listen.album {
            params.insert(String::from("album"), album.clone());
        }
        if let Some(duration) = listen.duration {
            params.insert(String::from("duration"), duration.to_string());
        }

        let body = self.request("track.scrobble", params, true).await?;
        let scrobbles = body.get("scrobbles");
        let item = scrobbles.and_then(|s| s.get("scrobble")).map(|sc| {
            if let Some(arr) = sc.as_array() {
                arr.first().cloned().unwrap_or(Value::Null)
            } else {
                sc.clone()
            }
        });

        let ignored_code = item
            .as_ref()
            .and_then(|i| i.get("ignoredMessage"))
            .and_then(|m| m.get("code"))
            .and_then(|c| {
                c.as_i64()
                    .or_else(|| c.as_str().and_then(|s| s.parse::<i64>().ok()))
            })
            .unwrap_or(0);

        if ignored_code != 0 {
            let msg = match ignored_code {
                1 => "Last.fm ignored the artist name.",
                2 => "Last.fm ignored the track name.",
                3 => "The original listening timestamp is too old for Last.fm.",
                4 => "The original listening timestamp is in the future.",
                5 => "Last.fm's daily scrobble limit was reached.",
                _ => "Last.fm ignored this listen.",
            };
            let kind = if ignored_code == 4 || ignored_code == 5 {
                FailureKind::Transient
            } else {
                FailureKind::Ignored
            };
            let retry_ms = if ignored_code == 5 {
                86_400_000
            } else if ignored_code == 4 {
                60_000
            } else {
                0
            };
            return Err(ScrobbleError::new(
                format!("LASTFM_IGNORED_{ignored_code}"),
                msg,
                kind,
                Some(200),
                retry_ms,
            ));
        }

        let attr = scrobbles.and_then(|s| s.get("@attr"));
        let accepted = attr
            .and_then(|a| a.get("accepted"))
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_default();
        let ignored = attr
            .and_then(|a| a.get("ignored"))
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_default();

        if accepted != "1" || ignored != "0" {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "Last.fm did not confirm acceptance of this listen.",
                FailureKind::Transient,
                Some(200),
                0,
            ));
        }

        Ok(())
    }

    /// Validates the connected session key (`user.getInfo`) and returns the Last.fm username.
    pub async fn validate_session(&self) -> Result<String, ScrobbleError> {
        let body = self.request("user.getInfo", BTreeMap::new(), true).await?;
        let username = body
            .get("user")
            .and_then(|u| u.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ScrobbleError::new(
                    "INVALID_RESPONSE",
                    "Last.fm did not confirm the connected account.",
                    FailureKind::Transient,
                    None,
                    0,
                )
            })?;
        Ok(username.to_owned())
    }

    /// Exchanges a short-lived callback `token` for `(username, session_key)` via `auth.getSession`.
    pub async fn exchange_token(&self, token: &str) -> Result<(String, String), ScrobbleError> {
        let mut params = BTreeMap::new();
        params.insert(String::from("token"), token.to_owned());
        let body = self.request("auth.getSession", params, false).await?;
        let session = body.get("session");
        let username = session
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let key = session
            .and_then(|s| s.get("key"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        let (Some(username), Some(key)) = (username, key) else {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "Last.fm did not return a valid session.",
                FailureKind::Transient,
                None,
                0,
            ));
        };

        Ok((username.to_owned(), key.to_owned()))
    }

    /// Validates application-level API key & shared secret via `auth.getToken`.
    pub async fn validate_application(&self) -> Result<(), ScrobbleError> {
        let body = self.request("auth.getToken", BTreeMap::new(), false).await?;
        let has_token = body
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        if !has_token {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "Last.fm did not validate the application credentials.",
                FailureKind::Transient,
                None,
                0,
            ));
        }
        Ok(())
    }
}
