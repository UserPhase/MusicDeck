//! # Redacting Telemetry & Bounded Log Ring Buffer (`logger`)
//!
//! Complete Rust port of `server/src/utils/logger.ts` and `server/src/utils/config-redaction.ts`.
//!
//! ## Core Responsibilities
//! 1. **Low-Overhead Credential & Token Redaction ([`redact_text`], [`redact_json_value`])**:
//!    - Strips ANSI terminal control sequences (`\x1b\[...`).
//!    - Masks registered runtime literal secrets (session secret, Navidrome password,
//!      Jellyfin API key, Spotify client secret) registered via [`register_log_secret`].
//!    - Masks HTTP URL userinfo (`https://user:pass@host` -> `https://[REDACTED]@host`).
//!    - Masks `Bearer` / `Basic` authorization headers and raw JWT strings (`eyJ...`).
//!    - Masks Subsonic and OAuth query parameters (`t`, `s`, `p`, `jwt`, `token`, `state`)
//!      while preserving non-sensitive identifiers such as `u=<username>`.
//!    - Masks `musicdeck_session` cookies, JSON credential fields, and CLI/env `KEY=VALUE` pairs.
//!    - Uses a fast `memchr` byte-scan preflight so plain log messages without special
//!      delimiters (`\x1b`, `@`, `=`, `:`) and without registered secrets bypass regex passes.
//! 2. **Bounded Circular Log Buffer ([`LogBuffer`])**:
//!    - Enforces both an entry count limit (`DEFAULT_LOG_CAPACITY = 1_000`) and a total
//!      heap byte ceiling (`DEFAULT_LOG_MAX_BYTES = 2 MiB`) inside a thread-safe
//!      [`tokio::sync::RwLock<VecDeque<LogSlot>>`].
//!    - Publishes real-time [`LogStreamEvent`] notifications over a `tokio::sync::broadcast`
//!      channel for administrative SSE tailing (`/api/admin/logs/stream`).
//! 3. **Custom `tracing` Subscriber Layer ([`RedactingLayer`], [`RedactingVisitor`])**:
//!    - Intercepts every `tracing::Event`, scrubs message text and structured field
//!      key-value pairs via [`RedactingVisitor`], appends the sanitized [`LogEntry`] to
//!      [`LogBuffer`], and writes redacted output to `stdout`.

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::io::Write;
use std::sync::{Arc, LazyLock, Once, RwLock as StdRwLock};

use chrono::{DateTime, Utc};
use memchr::memchr3;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{RwLock, broadcast};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

/// Canonical redaction replacement marker matching `server/src/utils/logger.ts`.
pub const REDACTED: &str = "[REDACTED]";

/// Default maximum number of log entries retained in [`LogBuffer`].
pub const DEFAULT_LOG_CAPACITY: usize = 1_000;

/// Default maximum total serialized byte size (2 MiB) retained in [`LogBuffer`].
pub const DEFAULT_LOG_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Maximum character length of a single log entry's `message` field before truncation.
pub const MAX_MESSAGE_CHARS: usize = 8 * 1024;

/// Maximum character length of a single log entry's `stack` field before truncation.
pub const MAX_STACK_CHARS: usize = 16 * 1024;

/// Maximum serialized character length of a log entry's `meta` object before truncation.
pub const MAX_META_CHARS: usize = 4 * 1024;

/// Minimum length (in bytes) required before [`register_log_secret`] tracks a literal secret,
/// preventing short 1–5 character strings from corrupting unrelated log messages.
pub const MIN_SECRET_LEN: usize = 6;

/// Supported log severity levels matching `LOG_LEVELS` in `server/src/utils/logger.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    /// Fatal or request-failing error condition.
    Error,
    /// Recoverable anomaly or degraded state warning.
    Warn,
    /// Standard operational milestone or request summary.
    Info,
    /// Verbose diagnostic trace.
    Debug,
}

impl LogLevel {
    /// Parses a case-insensitive log level string (`"error"`, `"warn"`, `"info"`, `"debug"`).
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" | "trace" => Some(Self::Debug),
            _ => None,
        }
    }

    /// Converts a `tracing::Level` into a MusicDeck [`LogLevel`].
    #[must_use]
    pub const fn from_tracing(level: &Level) -> Self {
        match *level {
            Level::ERROR => Self::Error,
            Level::WARN => Self::Warn,
            Level::INFO => Self::Info,
            Level::DEBUG | Level::TRACE => Self::Debug,
        }
    }
}

/// Subsystem origin of a recorded [`LogEntry`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    /// Structured HTTP/application event emitted by the server.
    #[default]
    Server,
    /// Diagnostic output captured from console/stdio helpers.
    Console,
    /// Process-level signal, panic hook, or runtime monitor event.
    Process,
}

/// Sanitized log record stored in [`LogBuffer`] and returned by `/api/admin/logs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    /// Stringified sequence identifier (`"1"`, `"2"`, ...) used as SSE `id:`.
    pub id: String,
    /// Monotonically increasing sequence number across the lifetime of the buffer.
    pub seq: u64,
    /// ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS.sssZ`).
    pub timestamp: String,
    /// Severity level of the entry.
    pub level: LogLevel,
    /// Subsystem source (`server`, `console`, `process`).
    pub source: LogSource,
    /// Redacted and length-bounded log message.
    pub message: String,
    /// Optional redacted and length-bounded stack trace or error chain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// Optional redacted and size-bounded structured metadata map.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

/// Input payload accepted by [`LogBuffer::push`] and [`LogBuffer::push_async`].
#[derive(Debug, Clone)]
pub struct LogInput {
    /// Severity level.
    pub level: LogLevel,
    /// Subsystem origin.
    pub source: LogSource,
    /// Raw (unredacted) log message text.
    pub message: String,
    /// Optional raw stack trace or backtrace text.
    pub stack: Option<String>,
    /// Optional structured metadata key-value pairs.
    pub meta: Option<Map<String, Value>>,
    /// Optional explicit UTC timestamp (defaults to `Utc::now()`).
    pub time: Option<DateTime<Utc>>,
}

impl LogInput {
    /// Convenience constructor for a server log message at `level`.
    #[must_use]
    pub fn new(level: LogLevel, message: impl Into<String>) -> Self {
        Self {
            level,
            source: LogSource::Server,
            message: message.into(),
            stack: None,
            meta: None,
            time: None,
        }
    }
}

/// Filter options for querying recent entries from [`LogBuffer`].
#[derive(Debug, Default, Clone, Copy)]
pub struct LogListOptions {
    /// Optional exact severity filter.
    pub level: Option<LogLevel>,
    /// Optional maximum number of newest matching entries to return.
    pub limit: Option<usize>,
    /// Optional sequence cursor; only entries with `seq > after` are returned.
    pub after: Option<u64>,
}

/// Snapshot of [`LogBuffer`] capacity and utilization metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBufferStats {
    /// Current number of entries stored in the circular buffer.
    pub size: usize,
    /// Maximum number of entries allowed before oldest-entry eviction.
    pub capacity: usize,
    /// Current approximate serialized byte footprint of all buffered entries.
    pub bytes: usize,
    /// Maximum serialized byte footprint allowed before oldest-entry eviction.
    pub max_bytes: usize,
    /// Highest sequence number assigned so far.
    pub last_seq: u64,
}

/// Real-time event broadcast to administrative SSE log stream subscribers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogStreamEvent {
    /// A new redacted [`LogEntry`] was appended to the buffer.
    Entry(LogEntry),
    /// The log buffer was cleared by an administrator.
    Cleared,
}

// ============================================================================
// Compiled Regex Set & Registered Secret Store
// ============================================================================

static KNOWN_SECRETS: LazyLock<StdRwLock<HashSet<String>>> =
    LazyLock::new(|| StdRwLock::new(HashSet::new()));

struct CompiledRedactionRules {
    ansi: Regex,
    sensitive_key: Regex,
    url_userinfo: Regex,
    bearer_or_basic: Regex,
    jwt_token: Regex,
    auth_header_kv: Regex,
    session_cookie: Regex,
    subsonic_and_url_query: Regex,
    json_secret_field: Regex,
    inline_secret_kv: Regex,
}

static REDACTION_RULES: LazyLock<CompiledRedactionRules> = LazyLock::new(|| {
    CompiledRedactionRules {
        ansi: Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("valid ANSI regex"),
        sensitive_key: Regex::new(
            r"(?i)(pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|session|credential|salt)",
        )
        .expect("valid sensitive key regex"),
        url_userinfo: Regex::new(r"(?i)\b(https?://)[^\s/\x22'<>]*@")
            .expect("valid URL userinfo regex"),
        bearer_or_basic: Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+")
            .expect("valid Bearer/Basic regex"),
        jwt_token: Regex::new(r"\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b")
            .expect("valid JWT regex"),
        auth_header_kv: Regex::new(
            r#"(?i)\b(authorization|proxy-authorization|cookie|set-cookie|x-emby-token|x-mediabrowser-token|x-api-key)(["']?\s*[:=]\s*["']?)[^"'\r\n,}]+"#,
        )
        .expect("valid auth header regex"),
        session_cookie: Regex::new(r#"musicdeck_session=[^;\s&"']+"#)
            .expect("valid session cookie regex"),
        // Subsonic & URL auth query parameters (`u` username stays visible).
        subsonic_and_url_query: Regex::new(
            r#"([?&](?:t|s|p|jwt|token|state|api_key|apiKey))=[^&#\s"']*"#,
        )
        .expect("valid Subsonic query regex"),
        json_secret_field: Regex::new(
            r#"(?i)(["'][\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[\w-]*["']\s*:\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)"#,
        )
        .expect("valid JSON secret field regex"),
        inline_secret_kv: Regex::new(
            r#"(?i)(\b[\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[\w-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}#;"']+)"#,
        )
        .expect("valid inline secret kv regex"),
    }
});

/// Registers a literal secret (session secret, Navidrome password, Jellyfin API key, etc.)
/// so any occurrence in log messages or metadata is replaced with `"[REDACTED]"`.
///
/// Values shorter than 6 bytes are ignored so short strings do not corrupt normal log output.
pub fn register_log_secret(value: &str) {
    let trimmed = value.trim();
    if trimmed.len() >= MIN_SECRET_LEN
        && let Ok(mut guard) = KNOWN_SECRETS.write()
    {
        guard.insert(trimmed.to_owned());
    }
}

/// Clears all registered literal secrets (primarily used by isolated unit tests).
pub fn clear_registered_secrets() {
    if let Ok(mut guard) = KNOWN_SECRETS.write() {
        guard.clear();
    }
}

/// Returns `true` if `key` matches known credential/token/cookie field names.
#[must_use]
pub fn is_sensitive_key(key: &str) -> bool {
    REDACTION_RULES.sensitive_key.is_match(key)
}

/// Scrubs ANSI escape codes, registered literal secrets, URL credentials, `Bearer`/`Basic`
/// headers, JWTs, Subsonic query parameters (`t`, `s`, `p`), session cookies, and JSON/KV
/// secret fields from `input`.
#[must_use]
pub fn redact_text(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    let rules = &*REDACTION_RULES;

    // 1. Strip ANSI escape sequences only when ESC (0x1B) byte is present.
    let mut output = if memchr::memchr(0x1b, input.as_bytes()).is_some() {
        rules.ansi.replace_all(input, "").into_owned()
    } else {
        input.to_owned()
    };

    // 2. Replace any registered literal secrets.
    if let Ok(secrets) = KNOWN_SECRETS.read() {
        for secret in secrets.iter() {
            if output.contains(secret.as_str()) {
                output = output.replace(secret.as_str(), REDACTED);
            }
        }
    }

    // 3. Fast-path byte scan: every pattern below requires at least one of `:`, `=`, `@`,
    //    or `"eyJ"` (JWT) or `"Bearer"`/`"Basic"`.
    let bytes = output.as_bytes();
    let has_delimiter = memchr3(b':', b'=', b'@', bytes).is_some()
        || output.contains("eyJ")
        || output.contains("Bearer")
        || output.contains("bearer")
        || output.contains("Basic")
        || output.contains("basic");

    if !has_delimiter {
        return output;
    }

    output = rules
        .url_userinfo
        .replace_all(&output, &format!("${{1}}{REDACTED}@"))
        .into_owned();
    output = rules
        .bearer_or_basic
        .replace_all(&output, &format!("${{1}} {REDACTED}"))
        .into_owned();
    output = rules.jwt_token.replace_all(&output, REDACTED).into_owned();
    output = rules
        .auth_header_kv
        .replace_all(&output, &format!("${{1}}${{2}}{REDACTED}"))
        .into_owned();
    output = rules
        .session_cookie
        .replace_all(&output, &format!("musicdeck_session={REDACTED}"))
        .into_owned();
    output = rules
        .subsonic_and_url_query
        .replace_all(&output, &format!("${{1}}={REDACTED}"))
        .into_owned();
    output = rules
        .json_secret_field
        .replace_all(&output, &format!("${{1}}\"{REDACTED}\""))
        .into_owned();
    output = rules
        .inline_secret_kv
        .replace_all(&output, &format!("${{1}}{REDACTED}"))
        .into_owned();

    output
}

/// Recursively scrubs a `serde_json::Value` tree up to depth 5, replacing sensitive keys
/// and redacting string leaves.
#[must_use]
pub fn redact_json_value(value: &Value, depth: usize) -> Value {
    match value {
        Value::String(s) => Value::String(redact_text(s)),
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::Array(items) => {
            if depth > 5 {
                return Value::String(String::from("[Object]"));
            }
            Value::Array(
                items
                    .iter()
                    .take(50)
                    .map(|item| redact_json_value(item, depth + 1))
                    .collect(),
            )
        }
        Value::Object(map) => {
            if depth > 5 {
                return Value::String(String::from("[Object]"));
            }
            let mut scrubbed = Map::with_capacity(map.len());
            for (key, item) in map {
                let redacted_item = if is_sensitive_key(key) && !item.is_null() {
                    Value::String(String::from(REDACTED))
                } else {
                    redact_json_value(item, depth + 1)
                };
                scrubbed.insert(key.clone(), redacted_item);
            }
            Value::Object(scrubbed)
        }
    }
}

/// Redaction mode for administrative configuration snapshots (`server/src/utils/config-redaction.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactConfigMode {
    /// Omit sensitive keys entirely from the returned map.
    Omit,
    /// Replace sensitive keys with a boolean indicating whether a non-empty value is set.
    Presence,
}

/// Redacts a configuration map according to `mode` and registers any discovered sibling secrets,
/// matching `redactConfig()` in `server/src/utils/config-redaction.ts`.
#[must_use]
pub fn redact_config(
    config: &Map<String, Value>,
    mode: RedactConfigMode,
    secret_keys: &HashSet<String>,
) -> Map<String, Value> {
    fn register_nested(val: &Value) {
        match val {
            Value::String(s) => register_log_secret(s),
            Value::Array(arr) => arr.iter().for_each(register_nested),
            Value::Object(map) => map.values().for_each(register_nested),
            _ => {}
        }
    }

    fn visit_value(val: &Value, mode: RedactConfigMode) -> Value {
        match val {
            Value::Array(arr) => Value::Array(arr.iter().map(|v| visit_value(v, mode)).collect()),
            Value::Object(map) => Value::Object(redact_config(map, mode, &HashSet::new())),
            Value::String(s) => Value::String(redact_text(s)),
            other => other.clone(),
        }
    }

    // First pass: register sibling secret values before scrubbing strings that may repeat them.
    for (key, value) in config {
        if secret_keys.contains(key) || is_sensitive_key(key) {
            register_nested(value);
        }
    }

    let mut result = Map::new();
    for (key, value) in config {
        if secret_keys.contains(key) || is_sensitive_key(key) {
            if mode == RedactConfigMode::Presence {
                let is_truthy = match value {
                    Value::Null => false,
                    Value::Bool(b) => *b,
                    Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
                    Value::String(s) => !s.is_empty(),
                    Value::Array(_) | Value::Object(_) => true,
                };
                result.insert(key.clone(), Value::Bool(is_truthy));
            }
        } else {
            result.insert(key.clone(), visit_value(value, mode));
        }
    }

    result
}

fn truncate_text(text: String, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text;
    }
    let truncated_prefix: String = text.chars().take(max_chars).collect();
    let omitted = char_count - max_chars;
    format!("{truncated_prefix}… [truncated {omitted} chars]")
}

// ============================================================================
// Bounded Circular LogBuffer (`Arc<RwLock<VecDeque<...>>>`)
// ============================================================================

#[derive(Debug, Clone)]
struct LogSlot {
    entry: LogEntry,
    bytes: usize,
}

#[derive(Debug)]
struct LogBufferState {
    slots: VecDeque<LogSlot>,
    capacity: usize,
    max_bytes: usize,
    bytes: usize,
    seq: u64,
}

impl LogBufferState {
    fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            slots: VecDeque::with_capacity(capacity.min(1024)),
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(256),
            bytes: 0,
            seq: 0,
        }
    }

    fn append(&mut self, input: LogInput) -> LogEntry {
        self.seq += 1;
        let timestamp = input
            .time
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let message = truncate_text(redact_text(&input.message), MAX_MESSAGE_CHARS);
        let stack = input
            .stack
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| truncate_text(redact_text(s), MAX_STACK_CHARS));

        let meta = input.meta.and_then(|raw_meta| {
            if raw_meta.is_empty() {
                return None;
            }
            let scrubbed_val = redact_json_value(&Value::Object(raw_meta), 0);
            let Value::Object(scrubbed_map) = scrubbed_val else {
                return None;
            };
            let serialized = serde_json::to_string(&scrubbed_map).unwrap_or_default();
            if serialized.chars().count() > MAX_META_CHARS {
                let preview: String = serialized.chars().take(MAX_META_CHARS).collect();
                let mut truncated_map = Map::new();
                truncated_map.insert(String::from("truncated"), Value::Bool(true));
                truncated_map.insert(String::from("preview"), Value::String(preview));
                Some(truncated_map)
            } else {
                Some(scrubbed_map)
            }
        });

        let entry = LogEntry {
            id: self.seq.to_string(),
            seq: self.seq,
            timestamp,
            level: input.level,
            source: input.source,
            message,
            stack,
            meta,
        };

        let entry_bytes = serde_json::to_vec(&entry).map_or(128, |v| v.len());

        if self.slots.len() >= self.capacity {
            self.evict_oldest();
        }
        while !self.slots.is_empty() && self.bytes + entry_bytes > self.max_bytes {
            self.evict_oldest();
        }

        self.bytes += entry_bytes;
        self.slots.push_back(LogSlot {
            entry: entry.clone(),
            bytes: entry_bytes,
        });

        entry
    }

    fn evict_oldest(&mut self) {
        if let Some(removed) = self.slots.pop_front() {
            self.bytes = self.bytes.saturating_sub(removed.bytes);
        }
    }

    fn list(&self, options: LogListOptions) -> Vec<LogEntry> {
        let mut filtered: Vec<LogEntry> = self
            .slots
            .iter()
            .filter(|slot| {
                if let Some(after) = options.after
                    && slot.entry.seq <= after
                {
                    return false;
                }
                if let Some(level) = options.level
                    && slot.entry.level != level
                {
                    return false;
                }
                true
            })
            .map(|slot| slot.entry.clone())
            .collect();

        if let Some(limit) = options.limit
            && filtered.len() > limit
        {
            let drop_count = filtered.len() - limit;
            filtered.drain(0..drop_count);
        }

        filtered
    }

    fn clear(&mut self) {
        self.slots.clear();
        self.bytes = 0;
    }

    fn stats(&self) -> LogBufferStats {
        LogBufferStats {
            size: self.slots.len(),
            capacity: self.capacity,
            bytes: self.bytes,
            max_bytes: self.max_bytes,
            last_seq: self.seq,
        }
    }
}

/// Thread-safe, bounded ring buffer of redacted [`LogEntry`] records backed by
/// `Arc<RwLock<VecDeque<...>>>` and a broadcast channel for SSE log streaming.
#[derive(Debug, Clone)]
pub struct LogBuffer {
    state: Arc<RwLock<LogBufferState>>,
    tx: broadcast::Sender<LogStreamEvent>,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_LOG_CAPACITY, DEFAULT_LOG_MAX_BYTES)
    }
}

impl LogBuffer {
    /// Creates a new [`LogBuffer`] bounded by `capacity` entries and `max_bytes` total bytes.
    #[must_use]
    pub fn new(capacity: usize, max_bytes: usize) -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            state: Arc::new(RwLock::new(LogBufferState::new(capacity, max_bytes))),
            tx,
        }
    }

    /// Asynchronously pushes a [`LogInput`] into the ring buffer, applying full secret redaction
    /// and size/count eviction.
    pub async fn push_async(&self, input: LogInput) -> LogEntry {
        let entry = {
            let mut guard = self.state.write().await;
            guard.append(input)
        };
        let _ = self.tx.send(LogStreamEvent::Entry(entry.clone()));
        entry
    }

    /// Synchronously pushes a [`LogInput`] into the ring buffer.
    ///
    /// Used by synchronous `tracing::Layer::on_event` callbacks and non-async callers.
    pub fn push(&self, input: LogInput) -> Option<LogEntry> {
        let mut guard = match self.state.try_write() {
            Ok(g) => g,
            Err(_) => {
                // Fallback to blocking_write when called outside an active lock holder.
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.state.blocking_write()
                })) {
                    Ok(g) => g,
                    Err(_) => return None,
                }
            }
        };
        let entry = guard.append(input);
        drop(guard);
        let _ = self.tx.send(LogStreamEvent::Entry(entry.clone()));
        Some(entry)
    }

    /// Asynchronously retrieves a filtered slice of buffered log entries (oldest to newest).
    pub async fn list_async(&self, options: LogListOptions) -> Vec<LogEntry> {
        let guard = self.state.read().await;
        guard.list(options)
    }

    /// Synchronously retrieves a filtered slice of buffered log entries.
    #[must_use]
    pub fn list(&self, options: LogListOptions) -> Vec<LogEntry> {
        if let Ok(guard) = self.state.try_read() {
            return guard.list(options);
        }
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.state.blocking_read().list(options)
        }))
        .unwrap_or_default()
    }

    /// Asynchronously clears all buffered log entries and notifies SSE subscribers.
    pub async fn clear_async(&self) {
        {
            let mut guard = self.state.write().await;
            guard.clear();
        }
        let _ = self.tx.send(LogStreamEvent::Cleared);
    }

    /// Synchronously clears all buffered log entries and notifies SSE subscribers.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.state.try_write() {
            guard.clear();
        } else if let Ok(mut guard) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.state.blocking_write()
        })) {
            guard.clear();
        }
        let _ = self.tx.send(LogStreamEvent::Cleared);
    }

    /// Asynchronously returns current buffer utilization statistics.
    pub async fn stats_async(&self) -> LogBufferStats {
        let guard = self.state.read().await;
        guard.stats()
    }

    /// Synchronously returns current buffer utilization statistics.
    #[must_use]
    pub fn stats(&self) -> LogBufferStats {
        if let Ok(guard) = self.state.try_read() {
            return guard.stats();
        }
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.state.blocking_read().stats()
        }))
        .unwrap_or(LogBufferStats {
            size: 0,
            capacity: DEFAULT_LOG_CAPACITY,
            bytes: 0,
            max_bytes: DEFAULT_LOG_MAX_BYTES,
            last_seq: 0,
        })
    }

    /// Subscribes to live [`LogStreamEvent`] broadcasts for `/api/admin/logs/stream`.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<LogStreamEvent> {
        self.tx.subscribe()
    }
}

/// Process-wide shared [`LogBuffer`] instance matching `serverLogs` in `server/src/utils/logger.ts`.
pub static SERVER_LOGS: LazyLock<LogBuffer> = LazyLock::new(LogBuffer::default);

/// Returns a clone of the process-wide [`LogBuffer`].
#[must_use]
pub fn server_logs() -> LogBuffer {
    SERVER_LOGS.clone()
}

// ============================================================================
// `RedactingVisitor` & `RedactingLayer` (`tracing-subscriber` integration)
// ============================================================================

/// Structured `tracing::field::Visit` implementation that extracts `message`, `stack`,
/// and arbitrary key-value metadata while scrubbing credentials and sensitive field names.
#[derive(Debug, Default)]
pub struct RedactingVisitor {
    /// Scrubbed primary message text.
    pub message: String,
    /// Optional scrubbed stack trace field.
    pub stack: Option<String>,
    /// Scrubbed structured key-value fields.
    pub fields: Map<String, Value>,
}

impl RedactingVisitor {
    /// Creates an empty [`RedactingVisitor`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn record_key_value(&mut self, field: &Field, raw_value: Value) {
        let name = field.name();
        if name == "message" {
            if let Value::String(s) = raw_value {
                self.message = redact_text(&s);
            } else {
                self.message = redact_text(&raw_value.to_string());
            }
            return;
        }

        if name == "stack" || name == "backtrace" {
            let text = match raw_value {
                Value::String(s) => s,
                other => other.to_string(),
            };
            self.stack = Some(redact_text(&text));
            return;
        }

        let sanitized = if is_sensitive_key(name) {
            Value::String(String::from(REDACTED))
        } else {
            redact_json_value(&raw_value, 0)
        };

        self.fields.insert(name.to_owned(), sanitized);
    }
}

impl Visit for RedactingVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_key_value(field, Value::String(value.to_owned()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_key_value(field, Value::Bool(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_key_value(field, Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_key_value(field, Value::Number(value.into()));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        let num = serde_json::Number::from_f64(value)
            .map_or_else(|| Value::String(value.to_string()), Value::Number);
        self.record_key_value(field, num);
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.record_key_value(field, Value::String(value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let formatted = format!("{value:?}");
        let unquoted = formatted
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .unwrap_or(&formatted);
        self.record_key_value(field, Value::String(unquoted.to_owned()));
    }
}

/// Custom `tracing_subscriber::Layer` that scrubs all event fields via [`RedactingVisitor`],
/// records structured entries into [`LogBuffer`], and emits sanitized lines to stdout.
#[derive(Clone)]
pub struct RedactingLayer {
    buffer: LogBuffer,
    emit_stdout: bool,
}

impl RedactingLayer {
    /// Creates a new [`RedactingLayer`] writing into `buffer` and optionally echoing to stdout.
    #[must_use]
    pub const fn new(buffer: LogBuffer, emit_stdout: bool) -> Self {
        Self {
            buffer,
            emit_stdout,
        }
    }
}

impl<S> Layer<S> for RedactingLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let level = LogLevel::from_tracing(metadata.level());

        let mut visitor = RedactingVisitor::new();
        event.record(&mut visitor);

        if ! metadata.target().is_empty() {
            visitor
                .fields
                .entry(String::from("target"))
                .or_insert_with(|| Value::String(metadata.target().to_owned()));
        }

        let message = if visitor.message.is_empty() {
            String::from("(structured event)")
        } else {
            visitor.message
        };

        let meta = if visitor.fields.is_empty() {
            None
        } else {
            Some(visitor.fields)
        };

        let recorded = self.buffer.push(LogInput {
            level,
            source: LogSource::Server,
            message,
            stack: visitor.stack,
            meta,
            time: Some(Utc::now()),
        });

        if self.emit_stdout
            && let Some(entry) = recorded
        {
            let level_tag = match entry.level {
                LogLevel::Error => "ERROR",
                LogLevel::Warn => "WARN ",
                LogLevel::Info => "INFO ",
                LogLevel::Debug => "DEBUG",
            };
            let meta_suffix = entry
                .meta
                .as_ref()
                .and_then(|m| serde_json::to_string(m).ok())
                .map_or_else(String::new, |json| format!(" {json}"));
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(
                stdout,
                "{} [{}] {}{}",
                entry.timestamp, level_tag, entry.message, meta_suffix
            );
        }
    }
}

static TRACING_INIT: Once = Once::new();

/// Initializes the global `tracing` subscriber with [`RedactingLayer`] wired to [`SERVER_LOGS`].
///
/// Safe to invoke multiple times across integration tests; only the first invocation
/// installs the global subscriber.
pub fn init_tracing() {
    init_tracing_with_buffer(SERVER_LOGS.clone());
}

/// Initializes the global `tracing` subscriber using a specific [`LogBuffer`].
pub fn init_tracing_with_buffer(buffer: LogBuffer) {
    TRACING_INIT.call_once(|| {
        let default_directive = std::env::var("LOG_LEVEL").map_or_else(
            |_| String::from("info,musicdeck_server=debug,tower_http=info"),
            |level| format!("{level},tower_http=info"),
        );

        let env_filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new(default_directive));

        let redacting_layer = RedactingLayer::new(buffer, true);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(redacting_layer)
            .init();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ring_buffer_enforces_entry_capacity_and_byte_budget() {
        let buffer = LogBuffer::new(3, DEFAULT_LOG_MAX_BYTES);
        for idx in 1..=5 {
            buffer
                .push_async(LogInput::new(LogLevel::Info, format!("m{idx}")))
                .await;
        }

        let listed = buffer.list_async(LogListOptions::default()).await;
        let messages: Vec<&str> = listed.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, vec!["m3", "m4", "m5"]);

        let stats = buffer.stats_async().await;
        assert_eq!(stats.size, 3);
        assert_eq!(stats.capacity, 3);
        assert_eq!(stats.last_seq, 5);

        // Byte cap eviction check
        let byte_bounded = LogBuffer::new(1_000, 2_000);
        for _ in 0..20 {
            byte_bounded
                .push_async(LogInput::new(LogLevel::Info, "x".repeat(300)))
                .await;
        }
        let byte_stats = byte_bounded.stats_async().await;
        assert!(byte_stats.bytes <= 2_000);
        assert!(byte_stats.size > 0 && byte_stats.size < 20);
    }

    #[tokio::test]
    async fn truncates_oversized_messages_and_filters_by_level_after_and_limit() {
        let buffer = LogBuffer::default();
        let entry = buffer
            .push_async(LogInput::new(LogLevel::Error, "y".repeat(20_000)))
            .await;
        assert!(entry.message.len() < 9_000);
        assert!(entry.message.contains("[truncated"));

        let filter_buf = LogBuffer::default();
        filter_buf
            .push_async(LogInput::new(LogLevel::Info, "a"))
            .await;
        filter_buf
            .push_async(LogInput::new(LogLevel::Error, "b"))
            .await;
        filter_buf
            .push_async(LogInput::new(LogLevel::Error, "c"))
            .await;
        filter_buf
            .push_async(LogInput::new(LogLevel::Warn, "d"))
            .await;

        let errors = filter_buf
            .list_async(LogListOptions {
                level: Some(LogLevel::Error),
                ..Default::default()
            })
            .await;
        assert_eq!(
            errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            vec!["b", "c"]
        );

        let limited = filter_buf
            .list_async(LogListOptions {
                limit: Some(2),
                ..Default::default()
            })
            .await;
        assert_eq!(
            limited
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "d"]
        );

        let after_two = filter_buf
            .list_async(LogListOptions {
                after: Some(2),
                ..Default::default()
            })
            .await;
        assert_eq!(
            after_two
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "d"]
        );
    }

    #[test]
    fn redacts_urls_tokens_subsonic_params_jwt_and_registered_secrets() {
        assert_eq!(
            redact_text("Failed https://user:secretpass@host/path"),
            "Failed https://[REDACTED]@host/path"
        );

        let sample = [
            "Authorization: Bearer abc.def.ghi",
            "cookie: musicdeck_session=s3cr3tvalue; other=1",
            "GET /rest/ping?u=admin&t=deadbeef&s=salty&p=enc:abc&jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345",
            r#"{"password":"hunter22","clientSecret":"xyz123"}"#,
            "API_KEY=supersecret token=abc",
        ]
        .join("\n");

        let scrubbed = redact_text(&sample);
        for forbidden in [
            "abc.def.ghi",
            "s3cr3tvalue",
            "deadbeef",
            "salty",
            "enc:abc",
            "eyJhbGciOiJIUzI1NiJ9",
            "hunter22",
            "xyz123",
            "supersecret",
        ] {
            assert!(
                !scrubbed.contains(forbidden),
                "expected '{forbidden}' to be redacted from: {scrubbed}"
            );
        }
        assert!(scrubbed.contains("u=admin"));

        register_log_secret("my-navidrome-pass-42");
        assert_eq!(
            redact_text("connect failed for my-navidrome-pass-42 at host"),
            "connect failed for [REDACTED] at host"
        );
    }

    #[tokio::test]
    async fn strips_ansi_and_scrubs_nested_meta_objects() {
        let buffer = LogBuffer::default();
        let mut headers = Map::new();
        headers.insert(String::from("cookie"), Value::String(String::from("a=b")));
        headers.insert(
            String::from("authorization"),
            Value::String(String::from("Bearer secret")),
        );
        headers.insert(
            String::from("host"),
            Value::String(String::from("localhost")),
        );

        let mut req = Map::new();
        req.insert(String::from("headers"), Value::Object(headers));

        let mut meta = Map::new();
        meta.insert(String::from("req"), Value::Object(req));
        meta.insert(String::from("apiKey"), Value::String(String::from("k")));

        let entry = buffer
            .push_async(LogInput {
                level: LogLevel::Info,
                source: LogSource::Server,
                message: String::from("\u{001b}[31mred\u{001b}[0m"),
                stack: None,
                meta: Some(meta),
                time: None,
            })
            .await;

        assert_eq!(entry.message, "red");
        let recorded_meta = entry.meta.expect("meta present");
        assert_eq!(
            recorded_meta.get("apiKey"),
            Some(&Value::String(String::from("[REDACTED]")))
        );
    }
}
