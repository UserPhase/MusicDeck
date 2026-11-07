//! # ListenBrainz REST API Scrobbler (`scrobbling::listenbrainz`)
//!
//! Ports `server/src/services/scrobble/ListenBrainzScrobbler.ts`:
//! - [`listenbrainz_payload`]: Constructs `{"listen_type": "single", "payload": [...]}`
//! - [`ListenBrainzScrobbler`]:
//!   - Validates user token (`1..=4096` bytes, no CR/LF/NUL)
//!   - `scrobble`: `POST https://api.listenbrainz.org/1/submit-listens` with `Authorization: Token <token>`
//!     and `10,240`-byte single-item payload limit
//!   - `validate_token`: `GET https://api.listenbrainz.org/1/validate-token`

use chrono::Utc;
use reqwest::{Client, Method};
use serde_json::{Value, json};

use crate::scrobbling::protocol::{
    FailureKind, ScrobbleError, ScrobbleListen, build_scrobble_http_client, http_failure,
    protocol_request, validate_listen,
};

/// Base URL for the ListenBrainz v1 REST API.
pub const LISTENBRAINZ_BASE_URL: &str = "https://api.listenbrainz.org/1";
/// Maximum serialized byte size of a single ListenBrainz listen item (`10 KiB`).
pub const LISTENBRAINZ_MAX_ITEM_BYTES: usize = 10_240;

/// Builds the ListenBrainz `submit-listens` JSON payload for a validated [`ScrobbleListen`].
pub fn listenbrainz_payload(listen: &ScrobbleListen) -> Result<Value, ScrobbleError> {
    validate_listen(listen)?;
    let mut track_metadata = json!({
        "artist_name": listen.artist,
        "track_name": listen.track,
    });
    if let Some(album) = &listen.album {
        track_metadata["release_name"] = json!(album);
    }

    Ok(json!({
        "listen_type": "single",
        "payload": [
            {
                "listened_at": listen.listened_at,
                "track_metadata": track_metadata,
            }
        ]
    }))
}

/// ListenBrainz v1 REST API scrobbler client.
#[derive(Debug, Clone)]
pub struct ListenBrainzScrobbler {
    token: String,
    http: Client,
    base_url: String,
}

impl ListenBrainzScrobbler {
    /// Creates a new [`ListenBrainzScrobbler`], validating the user token format.
    pub fn new(token: impl Into<String>) -> Result<Self, ScrobbleError> {
        Self::with_base_url(token, LISTENBRAINZ_BASE_URL)
    }

    /// Creates a new [`ListenBrainzScrobbler`] with a custom base URL (used for testing).
    pub fn with_base_url(
        token: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Result<Self, ScrobbleError> {
        let token = token.into();
        if token.is_empty()
            || token.len() > 4096
            || token.contains(['\r', '\n', '\0'])
        {
            return Err(ScrobbleError::new(
                "INVALID_TOKEN",
                "Enter a valid ListenBrainz user token.",
                FailureKind::Auth,
                None,
                0,
            ));
        }

        Ok(Self {
            token,
            http: build_scrobble_http_client(),
            base_url: base_url.into(),
        })
    }

    async fn request(&self, path: &str, payload: Option<&Value>) -> Result<Value, ScrobbleError> {
        let url = format!("{}/{}", self.base_url.trim_end_matches('/'), path);
        let mut headers = vec![("authorization", format!("Token {}", self.token))];
        let (method, body) = if let Some(json_val) = payload {
            headers.push(("content-type", String::from("application/json")));
            (Method::POST, Some(json_val.to_string()))
        } else {
            (Method::GET, None)
        };

        let resp = protocol_request(&self.http, method, &url, headers, body).await?;
        let now_ms = Utc::now().timestamp_millis();

        if !resp.status.is_success() {
            return Err(http_failure(resp.status, &resp.headers, now_ms));
        }

        let Some(body_obj) = resp.body.filter(Value::is_object) else {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "ListenBrainz returned an unreadable response.",
                FailureKind::Transient,
                Some(resp.status.as_u16()),
                0,
            ));
        };

        let has_error = body_obj.get("error").is_some_and(|v| !v.is_null())
            || matches!(
                body_obj.get("status").and_then(Value::as_str),
                Some("error" | "failed")
            )
            || body_obj
                .get("code")
                .and_then(Value::as_i64)
                .is_some_and(|c| c >= 400);

        if has_error {
            let status_code = body_obj.get("code").and_then(Value::as_i64).unwrap_or(0);
            let err_code = if status_code >= 400 {
                format!("LISTENBRAINZ_{status_code}")
            } else {
                String::from("LISTENBRAINZ_ERROR")
            };
            let kind = if status_code == 429 || status_code >= 500 {
                FailureKind::Transient
            } else if status_code == 401 || status_code == 403 {
                FailureKind::Auth
            } else {
                FailureKind::Permanent
            };
            return Err(ScrobbleError::new(
                err_code,
                "ListenBrainz rejected this request. Check the user token and track metadata.",
                kind,
                Some(resp.status.as_u16()),
                0,
            ));
        }

        Ok(body_obj)
    }

    /// Submits a single listen to `POST /1/submit-listens` and confirms `status == "ok"`.
    pub async fn scrobble(&self, listen: &ScrobbleListen) -> Result<(), ScrobbleError> {
        let payload = listenbrainz_payload(listen)?;
        let item_json = payload
            .get("payload")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .map(Value::to_string)
            .unwrap_or_default();

        if item_json.len() > LISTENBRAINZ_MAX_ITEM_BYTES {
            return Err(ScrobbleError::new(
                "LISTEN_TOO_LARGE",
                "Track metadata exceeds ListenBrainz's size limit.",
                FailureKind::Permanent,
                None,
                0,
            ));
        }

        let body = self.request("submit-listens", Some(&payload)).await?;
        if body.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "ListenBrainz did not confirm acceptance of this listen.",
                FailureKind::Transient,
                None,
                0,
            ));
        }

        Ok(())
    }

    /// Validates the user token against `GET /1/validate-token` and returns `user_name`.
    pub async fn validate_token(&self) -> Result<String, ScrobbleError> {
        let body = self.request("validate-token", None).await?;
        if body.get("valid") == Some(&Value::Bool(false)) {
            return Err(ScrobbleError::new(
                "INVALID_TOKEN",
                "ListenBrainz rejected this user token. Replace it in Settings.",
                FailureKind::Auth,
                Some(200),
                0,
            ));
        }

        let valid = body.get("valid") == Some(&Value::Bool(true));
        let user_name = body
            .get("user_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let (true, Some(user_name)) = (valid, user_name) else {
            return Err(ScrobbleError::new(
                "INVALID_RESPONSE",
                "ListenBrainz did not validate the account.",
                FailureKind::Transient,
                None,
                0,
            ));
        };

        Ok(user_name.to_owned())
    }
}
