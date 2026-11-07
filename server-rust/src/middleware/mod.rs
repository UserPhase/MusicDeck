//! # HTTP & Tower Middleware Layers (`middleware`)
//!
//! Houses security header injection (`security`), request authentication guards,
//! and privacy-scope enforcement layers.

pub mod auth;
pub mod security;

pub use auth::{require_admin_middleware, require_user_middleware};
pub use security::{
    DEFAULT_PERMISSIONS_POLICY, DEFAULT_STREAMING_CSP, FrameOptionsMode, HEADER_PERMISSIONS_POLICY,
    HEADER_X_XSS_PROTECTION, SecurityHeadersPolicy, security_headers_middleware,
};
