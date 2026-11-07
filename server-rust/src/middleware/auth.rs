//! # Authentication & Role Guard Middleware (`middleware::auth`)
//!
//! Provides Tower/Axum middleware functions (`require_user_middleware`,
//! `require_admin_middleware`) that complement the `FromRequestParts` extractors
//! ([`AuthenticatedUser`], [`RequireAdmin`]) in [`crate::auth::authorization`].
//!
//! When applied to a sub-router via `axum::middleware::from_fn_with_state`, these
//! middleware layers validate the caller's session before the inner handler runs
//! and insert the verified [`AuthenticatedUser`] into `request.extensions_mut()`.

use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::auth::{AuthenticatedUser, RequireAdmin};
use crate::error::ServerError;
use crate::state::AppState;

/// Axum middleware that requires an active authenticated user session (`401 Unauthorized`
/// if missing/expired) and attaches [`AuthenticatedUser`] to request extensions.
pub async fn require_user_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ServerError> {
    let (mut parts, body) = request.into_parts();
    let authenticated = AuthenticatedUser::from_request_parts(&mut parts, &state).await?;
    parts.extensions.insert(authenticated);
    let request = Request::from_parts(parts, body);
    Ok(next.run(request).await)
}

/// Axum middleware that requires an active administrator session (`401 Unauthorized` if
/// unauthenticated, `403 Forbidden` if non-admin) and attaches [`AuthenticatedUser`]
/// to request extensions.
pub async fn require_admin_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ServerError> {
    let (mut parts, body) = request.into_parts();
    let admin = RequireAdmin::from_request_parts(&mut parts, &state).await?;
    parts.extensions.insert(AuthenticatedUser {
        user: admin.user,
        session_id: admin.session_id,
    });
    let request = Request::from_parts(parts, body);
    Ok(next.run(request).await)
}
