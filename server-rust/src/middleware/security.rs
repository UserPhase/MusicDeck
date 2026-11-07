//! # HTTP Security Response Headers Middleware (`middleware::security`)
//!
//! Ports the browser-hardening response hook from `server/src/server.ts` into a
//! reusable Axum middleware function ([`security_headers_middleware`]) and configurable
//! policy struct ([`SecurityHeadersPolicy`]).
//!
//! ## Injected Headers
//! - `X-Content-Type-Options: nosniff`
//! - `X-Frame-Options: SAMEORIGIN` (or `DENY` when configured)
//! - `X-XSS-Protection: 1; mode=block`
//! - `Referrer-Policy: strict-origin-when-cross-origin`
//! - `Content-Security-Policy` (media-streaming-aware default policy)
//! - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
//!
//! Route-specific headers set by inner handlers (for example, a custom `Referrer-Policy`
//! or `Content-Security-Policy` on a specialized endpoint) are preserved without
//! being clobbered.

use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use http::header::{HeaderMap, HeaderName, HeaderValue};

/// Standard `X-XSS-Protection` header name (`x-xss-protection`).
pub static HEADER_X_XSS_PROTECTION: HeaderName = HeaderName::from_static("x-xss-protection");

/// Standard `Permissions-Policy` header name (`permissions-policy`).
pub static HEADER_PERMISSIONS_POLICY: HeaderName = HeaderName::from_static("permissions-policy");

/// Default `Content-Security-Policy` suitable for MusicDeck API and streaming responses,
/// permitting self-hosted assets, `data:`/`blob:` artwork and media buffers, and Cast scripts.
pub const DEFAULT_STREAMING_CSP: &str = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' http: https: ws: wss:; frame-src 'self'; form-action 'self'";

/// Default `Permissions-Policy` disabling unused sensitive browser hardware APIs.
pub const DEFAULT_PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/// Frame embedding restriction mode for `X-Frame-Options`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum FrameOptionsMode {
    /// Allow framing only by pages on the same origin (`SAMEORIGIN`).
    #[default]
    SameOrigin,
    /// Disallow all framing (`DENY`).
    Deny,
}

impl FrameOptionsMode {
    /// Returns the static [`HeaderValue`] for this [`FrameOptionsMode`].
    #[must_use]
    pub const fn as_header_value(self) -> HeaderValue {
        match self {
            Self::SameOrigin => HeaderValue::from_static("SAMEORIGIN"),
            Self::Deny => HeaderValue::from_static("DENY"),
        }
    }
}

/// Configurable HTTP security headers policy.
#[derive(Debug, Clone)]
pub struct SecurityHeadersPolicy {
    /// `X-Content-Type-Options` value (defaults to `"nosniff"`).
    pub content_type_options: HeaderValue,
    /// `X-Frame-Options` mode (`SAMEORIGIN` or `DENY`).
    pub frame_options: FrameOptionsMode,
    /// `X-XSS-Protection` value (defaults to `"1; mode=block"`).
    pub xss_protection: HeaderValue,
    /// `Referrer-Policy` value (defaults to `"strict-origin-when-cross-origin"`).
    pub referrer_policy: HeaderValue,
    /// `Content-Security-Policy` value.
    pub content_security_policy: HeaderValue,
    /// `Permissions-Policy` value.
    pub permissions_policy: HeaderValue,
}

impl Default for SecurityHeadersPolicy {
    fn default() -> Self {
        Self {
            content_type_options: HeaderValue::from_static("nosniff"),
            frame_options: FrameOptionsMode::SameOrigin,
            xss_protection: HeaderValue::from_static("1; mode=block"),
            referrer_policy: HeaderValue::from_static("strict-origin-when-cross-origin"),
            content_security_policy: HeaderValue::from_static(DEFAULT_STREAMING_CSP),
            permissions_policy: HeaderValue::from_static(DEFAULT_PERMISSIONS_POLICY),
        }
    }
}

impl SecurityHeadersPolicy {
    /// Applies the configured security headers to `headers` without clobbering any
    /// header already explicitly set by the inner route handler.
    pub fn apply(&self, headers: &mut HeaderMap) {
        insert_if_missing(
            headers,
            http::header::X_CONTENT_TYPE_OPTIONS,
            self.content_type_options.clone(),
        );
        insert_if_missing(
            headers,
            http::header::X_FRAME_OPTIONS,
            self.frame_options.as_header_value(),
        );
        insert_if_missing(
            headers,
            HEADER_X_XSS_PROTECTION.clone(),
            self.xss_protection.clone(),
        );
        insert_if_missing(
            headers,
            http::header::REFERRER_POLICY,
            self.referrer_policy.clone(),
        );
        insert_if_missing(
            headers,
            http::header::CONTENT_SECURITY_POLICY,
            self.content_security_policy.clone(),
        );
        insert_if_missing(
            headers,
            HEADER_PERMISSIONS_POLICY.clone(),
            self.permissions_policy.clone(),
        );
    }
}

fn insert_if_missing(headers: &mut HeaderMap, name: HeaderName, value: HeaderValue) {
    if !headers.contains_key(&name) {
        headers.insert(name, value);
    }
}

/// Axum middleware function (`axum::middleware::from_fn`) that attaches the default
/// [`SecurityHeadersPolicy`] to every outgoing HTTP response while respecting
/// route-level overrides.
pub async fn security_headers_middleware(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    SecurityHeadersPolicy::default().apply(response.headers_mut());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::middleware::from_fn;
    use axum::routing::get;
    use http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn injects_all_mandatory_security_headers() {
        let app = Router::new()
            .route("/test", get(|| async { "ok" }))
            .layer(from_fn(security_headers_middleware));

        let req = Request::builder()
            .uri("/test")
            .body(Body::empty())
            .expect("valid request");
        let res = app.oneshot(req).await.expect("response");

        assert_eq!(res.status(), StatusCode::OK);
        let headers = res.headers();
        assert_eq!(
            headers
                .get(http::header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            headers
                .get(http::header::X_FRAME_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("SAMEORIGIN")
        );
        assert_eq!(
            headers
                .get(&HEADER_X_XSS_PROTECTION)
                .and_then(|v| v.to_str().ok()),
            Some("1; mode=block")
        );
        assert_eq!(
            headers
                .get(http::header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("strict-origin-when-cross-origin")
        );
        assert_eq!(
            headers
                .get(http::header::CONTENT_SECURITY_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some(DEFAULT_STREAMING_CSP)
        );
        assert_eq!(
            headers
                .get(&HEADER_PERMISSIONS_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some(DEFAULT_PERMISSIONS_POLICY)
        );
    }

    #[tokio::test]
    async fn preserves_explicit_route_level_header_overrides() {
        let app = Router::new()
            .route(
                "/custom",
                get(|| async {
                    (
                        [(
                            http::header::REFERRER_POLICY,
                            HeaderValue::from_static("no-referrer"),
                        )],
                        "custom",
                    )
                }),
            )
            .layer(from_fn(security_headers_middleware));

        let req = Request::builder()
            .uri("/custom")
            .body(Body::empty())
            .expect("valid request");
        let res = app.oneshot(req).await.expect("response");

        assert_eq!(
            res.headers()
                .get(http::header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer")
        );
    }
}
