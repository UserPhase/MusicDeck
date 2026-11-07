//! # Role & Session Authorization Extractors (`auth::authorization`)
//!
//! Ports `server/src/auth/authorization.ts` into idiomatic Axum `FromRequestParts`
//! extractors:
//! - [`AuthenticatedUser`]: Requires a valid, non-expired session (`requireUser`).
//!   Accepts either a `musicdeck_session` cookie or an `Authorization: Bearer <jwt>`
//!   header, returning `401 Unauthorized` (`"Authentication required"`) on failure.
//! - [`RequireAdmin`]: Requires a valid session whose user has `role == "admin"`
//!   (`requireAdmin`), returning `403 Forbidden` (`"Admin access required"`) when a
//!   standard user attempts to access an administrative endpoint.
//! - [`OptionalUser`]: Resolves `Option<SessionUser>` without failing unauthenticated
//!   requests (used by `GET /api/auth/session`).

use axum::extract::FromRequestParts;
use http::header::AUTHORIZATION;
use http::request::Parts;

use crate::auth::sessions::{ SESSION_COOKIE, SessionUser, extract_session_cookie};
use crate::error::ServerError;
use crate::state::AppState;

/// Axum extractor that resolves the current [`SessionUser`] and current session ID,
/// rejecting unauthenticated requests with `401 Unauthorized` (`"Authentication required"`).
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    /// Authenticated user profile.
    pub user: SessionUser,
    /// Backing session ID (`sessions.id`).
    pub session_id: String,
}

/// Axum extractor that enforces `role == "admin"`, rejecting unauthenticated callers
/// with `401 Unauthorized` and non-admin users with `403 Forbidden` (`"Admin access required"`).
#[derive(Debug, Clone)]
pub struct RequireAdmin {
    /// Authenticated administrator profile.
    pub user: SessionUser,
    /// Backing session ID (`sessions.id`).
    pub session_id: String,
}

/// Non-failing Axum extractor that resolves `Option<AuthenticatedUser>` (for `/api/auth/session`).
#[derive(Debug, Clone, Default)]
pub struct OptionalUser(pub Option<AuthenticatedUser>);

async fn resolve_from_parts(
    parts: &Parts,
    state: &AppState,
) -> Result<Option<AuthenticatedUser>, ServerError> {
    let Some(store) = state.session_store() else {
        return Ok(None);
    };

    // 1. Check `Cookie: musicdeck_session=<id>` first (primary browser/client auth).
    if let Some(cookie_session_id) = extract_session_cookie(&parts.headers)
        && let Some(user) = store
            .get_session_user_by_id(&cookie_session_id)
            .await
            .map_err(|err| ServerError::Internal(err.to_string()))?
    {
        return Ok(Some(AuthenticatedUser {
            user,
            session_id: cookie_session_id,
        }));
    }

    // 2. Fallback to `Authorization: Bearer <token>` (JWT claims or direct session token).
    if let Some(auth_header) = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        && let Some(raw_token) = auth_header
            .strip_prefix("Bearer ")
            .or_else(|| auth_header.strip_prefix("bearer "))
    {
        let token = raw_token.trim();
        if !token.is_empty() {
            let candidate_sid = if let Ok(claims) = store.verify_jwt(token) {
                claims.sid
            } else {
                token.to_owned()
            };

            if let Some(user) = store
                .get_session_user_by_id(&candidate_sid)
                .await
                .map_err(|err| ServerError::Internal(err.to_string()))?
            {
                return Ok(Some(AuthenticatedUser {
                    user,
                    session_id: candidate_sid,
                }));
            }
        }
    }

    let _ = SESSION_COOKIE;
    Ok(None)
}

#[axum::async_trait]
impl FromRequestParts<AppState> for OptionalUser {
    type Rejection = ServerError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let resolved = resolve_from_parts(parts, state).await?;
        Ok(Self(resolved))
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = ServerError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(authenticated) = resolve_from_parts(parts, state).await? else {
            return Err(ServerError::Unauthorized(String::from(
                "Authentication required",
            )));
        };
        Ok(authenticated)
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for RequireAdmin {
    type Rejection = ServerError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let authenticated = AuthenticatedUser::from_request_parts(parts, state).await?;
        if !authenticated.user.is_admin() {
            return Err(ServerError::Forbidden(String::from(
                "Admin access required",
            )));
        }
        Ok(Self {
            user: authenticated.user,
            session_id: authenticated.session_id,
        })
    }
}
