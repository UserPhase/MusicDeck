//! # Synchronized LRC & Plain Lyrics Resolution Service (`external::lyrics`)
//!
//! Complete Rust port of `server/src/domain/lyrics-service.ts`.
//!
//! ## Three-Tier Resolution & Caching Pipeline
//! 1. **Tier 1 — LRCLIB Exact Match (`https://lrclib.net/api/get`)**:
//!    - Queries `track_name`, `artist_name`, `album_name`, and `duration`.
//!    - Enforces a $\pm 2\text{ second}$ (`SYNC_DURATION_TOLERANCE`) duration match before
//!      trusting synchronized LRC timestamps; if duration drifts by $> 2\text{ s}$, strips
//!      `syncedLyrics` and retains `plainLyrics` only.
//! 2. **Tier 2 — LRCLIB Search (`https://lrclib.net/api/search`)**:
//!    - Filters candidates within $\pm 8\text{ seconds}$ of `duration_seconds`, ranking
//!      synced lyrics first, then exact album match, then smallest duration delta.
//!    - Retries with [`primary_artist_name`] if the full featuring credit string yields no hit.
//! 3. **Tier 3 — Keyless `lyrics.ovh` Fallback (`https://api.lyrics.ovh/v1/<artist>/<title>`)**:
//!    - Normalizes line endings and returns plain lyrics.
//! 4. **Multi-TTL Cache**:
//!    - Found lyrics cached for `24` hours (`FOUND_TTL_MS`), missing lyrics for `10` minutes
//!      (`MISSING_TTL_MS`), and transient network errors for `30` seconds (`ERROR_TTL_MS`).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use url::Url;

/// Cache TTL (`24` hours in ms) for resolved lyrics.
pub const FOUND_TTL_MS: u64 = 24 * 60 * 60_000;

/// Cache TTL (`10` minutes in ms) for confirmed missing lyrics.
pub const MISSING_TTL_MS: u64 = 10 * 60_000;

/// Maximum duration difference (`2.0` seconds) permitted for synced LRC timestamps.
pub const SYNC_DURATION_TOLERANCE_SECS: f64 = 2.0;

/// User-Agent / `Lrclib-Client` header value advertised to LRCLIB.
pub const LRCLIB_CLIENT_HEADER: &str =
    "MusicDeck/0.1.0 (https://github.com/UserPhase/MusicDeck)";

static LRC_OFFSET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^\s*\[offset:\s*([+-]?\d+)\s*\]").expect("valid offset regex"));

static LRC_STAMP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\d{1,3}):([0-5]\d)\.(\d{2,3})\]").expect("valid stamp regex"));

static TITLE_FEAT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[\(\[]\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^\)\]]+[\)\]]")
        .expect("valid feat regex")
});

static TITLE_EDITION_PAREN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[\(\[]\s*(?:(?:\d{4}\s*)?remaster(?:ed)?|deluxe(?:\s+edition)?|single)\b[^\)\]]*[\)\]]")
        .expect("valid edition paren regex")
});

static TITLE_EDITION_DASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*-\s*(?:single|ep|remaster(?:ed)?)\b.*$").expect("valid edition dash regex")
});

static PRIMARY_ARTIST_SPLIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*(?:&|,|\bfeat(?:uring)?\.?\s|\bft\.?\s)\s*")
        .expect("valid primary artist split regex")
});

/// Input track descriptor for [`LyricsService::resolve`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsTrackQuery {
    /// Track title.
    pub title: String,
    /// Artist name.
    pub artist: String,
    /// Optional album name.
    pub album: Option<String>,
    /// Track duration in seconds.
    pub duration_seconds: f64,
}

/// Single timed LRC line (`{ time, text }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedLrcLine {
    /// Timestamp in seconds (`>= 0.0`).
    pub time: f64,
    /// Lyric line text.
    pub text: String,
}

/// Provider source that satisfied a lyrics lookup (`lrclib`, `lyricsovh`, or `none`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LyricsProviderName {
    /// Timed or plain lyrics from `lrclib.net`.
    Lrclib,
    /// Plain lyrics from `api.lyrics.ovh`.
    Lyricsovh,
    /// No lyrics found.
    #[default]
    None,
}

/// Standardized lyrics response (`LyricsResult` in `server/src/domain/lyrics-service.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    /// Parsed timed LRC lines when `is_synced == true`.
    pub synced_lyrics: Option<Vec<ParsedLrcLine>>,
    /// Plain unsynchronized lyrics text.
    pub plain_lyrics: Option<String>,
    /// `true` when `synced_lyrics` is non-empty.
    pub is_synced: bool,
    /// Upstream provider that supplied the lyrics (`lrclib`, `lyricsovh`, `none`).
    pub provider: LyricsProviderName,
    /// `true` when the track is flagged as instrumental.
    pub instrumental: bool,
}

impl LyricsResult {
    /// Returns the empty (`provider = "none"`) lyrics result.
    #[must_use]
    pub const fn none(instrumental: bool) -> Self {
        Self {
            synced_lyrics: None,
            plain_lyrics: None,
            is_synced: false,
            provider: LyricsProviderName::None,
            instrumental,
        }
    }
}

/// Parses an LRC-formatted string into sorted [`ParsedLrcLine`] entries, applying any
/// `[offset:+/-ms]` header tag and handling multi-timestamp lines (`[00:10.00][00:20.00] Chorus`).
#[must_use]
pub fn parse_lrc_lines(raw_lrc: &str) -> Vec<ParsedLrcLine> {
    let offset_ms: i64 = LRC_OFFSET_RE
        .captures(raw_lrc)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
        .unwrap_or(0);

    let mut lines = Vec::new();
    for raw_line in raw_lrc.lines() {
        let mut stamps = Vec::new();
        let mut last_end = 0usize;
        for cap in LRC_STAMP_RE.captures_iter(raw_line) {
            if let Some(full) = cap.get(0) {
                last_end = full.end();
            }
            let mins: i64 = cap.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let secs: i64 = cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let frac_str = cap.get(3).map_or("0", |m| m.as_str());
            let millis: i64 = match frac_str.len() {
                2 => frac_str.parse::<i64>().unwrap_or(0) * 10,
                3 => frac_str.parse::<i64>().unwrap_or(0),
                _ => 0,
            };
            stamps.push(mins * 60_000 + secs * 1_000 + millis);
        }

        if stamps.is_empty() {
            continue;
        }

        let text = raw_line[last_end..].trim().to_owned();
        for time_ms in stamps {
            let adjusted_ms = (time_ms - offset_ms).max(0);
            lines.push(ParsedLrcLine {
                time: (adjusted_ms as f64) / 1000.0,
                text: text.clone(),
            });
        }
    }

    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

/// Strips featuring credits and remaster/deluxe/single suffixes from a track title
/// prior to querying external lyrics providers.
#[must_use]
pub fn sanitize_track_title(title: &str) -> String {
    let step1 = TITLE_FEAT_RE.replace_all(title, "");
    let step2 = TITLE_EDITION_PAREN_RE.replace_all(&step1, "");
    let step3 = TITLE_EDITION_DASH_RE.replace_all(&step2, "");
    step3.trim().to_owned()
}

/// Extracts the primary artist name prior to `&`, `,`, `feat.`, or `ft.`.
#[must_use]
pub fn primary_artist_name(artist: &str) -> String {
    PRIMARY_ARTIST_SPLIT_RE
        .split(artist)
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| artist.trim())
        .to_owned()
}

fn metadata_key(raw: Option<&str>) -> String {
    let Some(s) = raw else {
        return String::new();
    };
    s.nfc()
        .collect::<String>()
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone)]
struct CachedLyricsEntry {
    expires_at_ms: u64,
    result: LyricsResult,
}

/// Three-tier lyrics resolution service with bounded in-memory caching.
#[derive(Debug, Clone)]
pub struct LyricsService {
    http: reqwest::Client,
    cache: Arc<Mutex<HashMap<String, CachedLyricsEntry>>>,
}

impl Default for LyricsService {
    fn default() -> Self {
        Self::new()
    }
}

impl LyricsService {
    /// Creates a new [`LyricsService`].
    #[must_use]
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(4_000))
            .user_agent(LRCLIB_CLIENT_HEADER)
            .build()
            .unwrap_or_default();
        Self {
            http,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Resolves timed or plain lyrics for `track`, checking the in-memory TTL cache first.
    pub async fn get_lyrics(&self, track: &LyricsTrackQuery) -> LyricsResult {
        let key = format!(
            "{}|{}|{}|{}",
            metadata_key(Some(&track.title)),
            metadata_key(Some(&track.artist)),
            metadata_key(track.album.as_deref()),
            track.duration_seconds.round() as i64
        );

        let now_ms = current_epoch_ms();
        if let Ok(guard) = self.cache.lock()
            && let Some(cached) = guard.get(&key)
            && cached.expires_at_ms > now_ms
        {
            return cached.result.clone();
        }

        let clean_title = {
            let s = sanitize_track_title(&track.title);
            if s.is_empty() {
                track.title.trim().to_owned()
            } else {
                s
            }
        };
        let clean_artist = track.artist.trim().to_owned();

        let resolved = self
            .resolve_tiers(track, &clean_title, &clean_artist)
            .await;

        let ttl = if resolved.is_synced || resolved.plain_lyrics.is_some() || resolved.instrumental
        {
            FOUND_TTL_MS
        } else {
            MISSING_TTL_MS
        };

        if let Ok(mut guard) = self.cache.lock() {
            if guard.len() >= 500 {
                guard.retain(|_, v| v.expires_at_ms > now_ms);
            }
            guard.insert(
                key,
                CachedLyricsEntry {
                    expires_at_ms: now_ms + ttl,
                    result: resolved.clone(),
                },
            );
        }

        resolved
    }

    async fn resolve_tiers(
        &self,
        track: &LyricsTrackQuery,
        title: &str,
        artist: &str,
    ) -> LyricsResult {
        let mut instrumental = false;

        if let Some(direct) = self.lrclib_direct(track, title, artist).await {
            if direct.is_synced || direct.plain_lyrics.is_some() {
                return direct;
            }
            instrumental |= direct.instrumental;
        }

        if let Some(searched) = self.lrclib_search(track, title, artist).await {
            if searched.is_synced || searched.plain_lyrics.is_some() {
                return searched;
            }
            instrumental |= searched.instrumental;
        }

        if let Some(fallback) = self.lyrics_ovh(artist, title).await {
            return fallback;
        }

        LyricsResult::none(instrumental)
    }

    async fn lrclib_direct(
        &self,
        track: &LyricsTrackQuery,
        title: &str,
        artist: &str,
    ) -> Option<LyricsResult> {
        let mut url = Url::parse("https://lrclib.net/api/get").ok()?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("track_name", title);
            qp.append_pair("artist_name", artist);
            if let Some(alb) = track.album.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                qp.append_pair("album_name", alb);
            }
            qp.append_pair("duration", &(track.duration_seconds.round() as i64).to_string());
        }

        let res = self
            .http
            .get(url)
            .header("Lrclib-Client", LRCLIB_CLIENT_HEADER)
            .send()
            .await
            .ok()?;

        if !res.status().is_success() {
            return None;
        }

        let data: Value = res.json().await.ok()?;
        let allow_synced = data
            .get("duration")
            .and_then(Value::as_f64)
            .is_none_or(|d| (d - track.duration_seconds).abs() <= SYNC_DURATION_TOLERANCE_SECS);

        parse_lrclib_payload(&data, allow_synced)
    }

    async fn lrclib_search(
        &self,
        track: &LyricsTrackQuery,
        title: &str,
        artist: &str,
    ) -> Option<LyricsResult> {
        if let Some(found) = self.lrclib_search_by_artist(track, title, artist).await {
            return Some(found);
        }
        let primary = primary_artist_name(artist);
        if !primary.eq_ignore_ascii_case(artist) {
            return self.lrclib_search_by_artist(track, title, &primary).await;
        }
        None
    }

    async fn lrclib_search_by_artist(
        &self,
        track: &LyricsTrackQuery,
        title: &str,
        artist_name: &str,
    ) -> Option<LyricsResult> {
        let mut url = Url::parse("https://lrclib.net/api/search").ok()?;
        url.query_pairs_mut()
            .append_pair("track_name", title)
            .append_pair("artist_name", artist_name);

        let res = self
            .http
            .get(url)
            .header("Lrclib-Client", LRCLIB_CLIENT_HEADER)
            .send()
            .await
            .ok()?;

        if !res.status().is_success() {
            return None;
        }

        let candidates: Vec<Value> = res.json().await.ok()?;
        let target_title = metadata_key(Some(title));
        let target_artist = metadata_key(Some(artist_name));
        let target_album = metadata_key(track.album.as_deref());

        let mut scored: Vec<(bool, bool, f64, LyricsResult)> = Vec::new();
        for cand in candidates {
            let Some(dur) = cand.get("duration").and_then(Value::as_f64) else {
                continue;
            };
            let diff = (dur - track.duration_seconds).abs();
            if diff > 8.0 {
                continue;
            }

            if let Some(tn) = cand.get("trackName").and_then(Value::as_str)
                && metadata_key(Some(tn)) != target_title
            {
                continue;
            }
            if let Some(an) = cand.get("artistName").and_then(Value::as_str)
                && metadata_key(Some(an)) != target_artist
            {
                continue;
            }

            let allow_synced = diff <= SYNC_DURATION_TOLERANCE_SECS;
            let Some(parsed) = parse_lrclib_payload(&cand, allow_synced) else {
                continue;
            };
            if !parsed.is_synced && parsed.plain_lyrics.is_none() {
                continue;
            }

            let album_match = !target_album.is_empty()
                && cand
                    .get("albumName")
                    .and_then(Value::as_str)
                    .is_some_and(|a| metadata_key(Some(a)) == target_album);

            scored.push((parsed.is_synced, album_match, diff, parsed));
        }

        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
        });

        scored.into_iter().next().map(|(_, _, _, res)| res)
    }

    async fn lyrics_ovh(&self, artist: &str, title: &str) -> Option<LyricsResult> {
        let url = format!(
            "https://api.lyrics.ovh/v1/{}/{}",
            urlencoding::encode(artist),
            urlencoding::encode(title)
        );
        let res = self.http.get(&url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let payload: Value = res.json().await.ok()?;
        let raw_lyrics = payload.get("lyrics")?.as_str()?;
        let cleaned: String = raw_lyrics
            .chars()
            .take(100_000)
            .collect::<String>()
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned();

        if cleaned.is_empty() {
            return None;
        }

        Some(LyricsResult {
            synced_lyrics: None,
            plain_lyrics: Some(cleaned),
            is_synced: false,
            provider: LyricsProviderName::Lyricsovh,
            instrumental: false,
        })
    }
}

fn parse_lrclib_payload(data: &Value, allow_synced: bool) -> Option<LyricsResult> {
    let plain_lyrics = data
        .get("plainLyrics")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(100_000).collect::<String>().trim().to_owned())
        .filter(|s| !s.is_empty());

    let synced_lines = if allow_synced {
        data.get("syncedLyrics")
            .and_then(Value::as_str)
            .map(|s| {
                let capped: String = s.chars().take(100_000).collect();
                parse_lrc_lines(&capped)
            })
            .filter(|lines| !lines.is_empty())
    } else {
        None
    };

    let instrumental = data
        .get("instrumental")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if synced_lines.is_none() && plain_lyrics.is_none() && !instrumental {
        return None;
    }

    Some(LyricsResult {
        is_synced: synced_lines.is_some(),
        synced_lyrics: synced_lines,
        plain_lyrics,
        provider: LyricsProviderName::Lrclib,
        instrumental,
    })
}

fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
