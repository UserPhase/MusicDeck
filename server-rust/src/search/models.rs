//! # Unified Search Models & Provider Trait (`search::models`)
//!
//! Ports `server/src/domain/search.ts`:
//! - [`SearchResultType`] (`track | album | artist | playlist`)
//! - [`SearchProviderKind`] (`library | musicdeck | plugin | external`)
//! - [`UnifiedSearchResult`] and [`SearchGroups`]
//! - [`SearchProvider`] async trait for built-in and plugin search providers
//! - Projection helpers (`to_track_search_result`, `to_album_search_result`,
//!   `to_artist_search_result`, `to_playlist_search_result`, `group_search_results`,
//!   and `to_legacy_search_response`)

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthenticatedUser;
use crate::catalog::{
    Availability, CanonicalIdentity, CatalogEntityType, SourceOption, UnifiedCatalogItem,
};
use crate::external::{ExternalArtworkRef, ExternalSearchItem};
use crate::playlists::Playlist;
use crate::providers::{Album, Artist, ArtistCredit, AudioMetadata, IdentityHints, Loudness, Track};

/// Search entity classification (`track | album | artist | playlist`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchResultType {
    Track,
    Album,
    Artist,
    Playlist,
}

impl SearchResultType {
    /// Converts into [`CatalogEntityType`].
    #[must_use]
    pub const fn to_catalog_entity_type(self) -> CatalogEntityType {
        match self {
            Self::Track => CatalogEntityType::Track,
            Self::Album => CatalogEntityType::Album,
            Self::Artist => CatalogEntityType::Artist,
            Self::Playlist => CatalogEntityType::Playlist,
        }
    }

    /// Parses a string into a [`SearchResultType`].
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "track" | "tracks" => Some(Self::Track),
            "album" | "albums" => Some(Self::Album),
            "artist" | "artists" => Some(Self::Artist),
            "playlist" | "playlists" => Some(Self::Playlist),
            _ => None,
        }
    }
}

/// Origin provider tier (`library | musicdeck | external | plugin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchProviderKind {
    Library,
    Musicdeck,
    External,
    Plugin,
}

impl SearchProviderKind {
    /// Deterministic preference rank (`library = 0 < musicdeck = 1 < external = 2 < plugin = 3`).
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Library => 0,
            Self::Musicdeck => 1,
            Self::External => 2,
            Self::Plugin => 3,
        }
    }

    /// Parses a string into a [`SearchProviderKind`].
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "library" => Self::Library,
            "musicdeck" => Self::Musicdeck,
            "plugin" => Self::Plugin,
            _ => Self::External,
        }
    }
}

/// Search execution mode (`library | hybrid | external`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Library,
    #[default]
    Hybrid,
    External,
}

/// Options passed to [`SearchProvider::search`].
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub user: Option<AuthenticatedUser>,
    pub types: Option<Vec<SearchResultType>>,
    pub limit: Option<usize>,
    pub mode: SearchMode,
}

impl SearchOptions {
    /// Returns `true` if `result_type` is included by `self.types`.
    #[must_use]
    pub fn includes(&self, result_type: SearchResultType) -> bool {
        self.types
            .as_ref()
            .is_none_or(|list| list.is_empty() || list.contains(&result_type))
    }
}

/// Source descriptor embedded inside [`UnifiedSearchResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultSource {
    /// `"library" | "musicdeck" | "external"`.
    pub kind: String,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SourceOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_available: Option<bool>,
}

/// Rich metadata payload embedded in [`UnifiedSearchResult`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_metadata: Option<AudioMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalization_gain_db: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness: Option<Loudness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_track_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spotify_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deezer_track_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deezer_track_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub itunes_track_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
}

/// Normalized search result model across library, playlist, external, and plugin providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSearchResult {
    #[serde(rename = "type")]
    pub item_type: SearchResultType,
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_credits: Option<Vec<ArtistCredit>>,
    pub album: Option<String>,
    pub artwork: Option<ExternalArtworkRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    pub provider: SearchProviderKind,
    pub source: SearchResultSource,
    pub availability: Option<Availability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<CanonicalIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<SearchProviderKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_library: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_album_id: Option<String>,
    #[serde(default)]
    pub metadata: SearchResultMetadata,
    /// Internal matching input; stripped before sending API responses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_hints: Option<IdentityHints>,
}

impl UnifiedSearchResult {
    /// Converts this search item into a [`UnifiedCatalogItem`] for canonical identity derivation.
    #[must_use]
    pub fn to_catalog_item(&self) -> UnifiedCatalogItem {
        UnifiedCatalogItem {
            id: self.id.clone(),
            item_type: self.item_type.to_catalog_entity_type(),
            provider: match self.provider {
                SearchProviderKind::Library => String::from("library"),
                SearchProviderKind::Musicdeck => String::from("musicdeck"),
                SearchProviderKind::External => String::from("external"),
                SearchProviderKind::Plugin => String::from("plugin"),
            },
            title: self.title.clone(),
            artist: self.artist.clone(),
            artist_credits: self.artist_credits.clone(),
            album: self.album.clone(),
            duration_seconds: self.metadata.duration_seconds,
            artwork: self.artwork.as_ref().map(|art| art.url.clone()),
            identity_hints: self.identity_hints.clone().or_else(|| {
                self.metadata.isrc.as_ref().map(|isrc| IdentityHints {
                    music_brainz_id: None,
                    isrc: Some(isrc.clone()),
                    upc: None,
                })
            }),
            identity: self.identity.clone(),
        }
    }

    /// Converts an [`ExternalSearchItem`] from `src/external/adapters.rs` into a [`UnifiedSearchResult`].
    #[must_use]
    pub fn from_external_item(item: ExternalSearchItem) -> Self {
        let item_type =
            SearchResultType::parse(item.item_type.as_str()).unwrap_or(SearchResultType::Track);
        let provider = SearchProviderKind::parse(&item.provider);
        let duration_seconds = item
            .metadata
            .get("durationSeconds")
            .and_then(Value::as_u64)
            .map(|v| v as u32);
        let year = item
            .metadata
            .get("year")
            .and_then(Value::as_i64)
            .map(|v| v as i32);
        let song_count = item
            .metadata
            .get("songCount")
            .and_then(Value::as_u64)
            .map(|v| v as u32);
        let deezer_track_id = item.metadata.get("deezerTrackId").and_then(Value::as_u64);
        let deezer_track_url = item
            .metadata
            .get("deezerTrackUrl")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let itunes_track_id = item.metadata.get("itunesTrackId").and_then(Value::as_u64);
        let isrc = item
            .metadata
            .get("isrc")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let artist_id = item
            .metadata
            .get("artistId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let album_id = item
            .metadata
            .get("albumId")
            .and_then(Value::as_str)
            .map(str::to_owned);

        Self {
            item_type,
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            artist: item.artist,
            artist_credits: None,
            album: item.album,
            artwork: item.artwork,
            preview_url: item.preview_url,
            provider,
            source: SearchResultSource {
                kind: item.source.kind,
                count: item.source.count,
                options: None,
                external_available: item.source.external_available,
            },
            availability: item
                .availability
                .and_then(|v| serde_json::from_value(v).ok()),
            identity: None,
            providers: Some(vec![provider]),
            in_library: item.in_library,
            local_track_id: item.local_track_id,
            local_album_id: item.local_album_id,
            metadata: SearchResultMetadata {
                duration_seconds,
                year,
                song_count,
                artist_id,
                album_id,
                deezer_track_id,
                deezer_track_url,
                itunes_track_id,
                isrc,
                ..SearchResultMetadata::default()
            },
            identity_hints: item.identity_hints,
        }
    }
}

/// Grouped search results across `track`, `album`, `artist`, and `playlist`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSearchGroups {
    pub track: Vec<UnifiedSearchResult>,
    pub album: Vec<UnifiedSearchResult>,
    pub artist: Vec<UnifiedSearchResult>,
    pub playlist: Vec<UnifiedSearchResult>,
}

/// Result returned by a single search provider during federated query execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProviderResult {
    pub provider_id: String,
    pub items: Vec<UnifiedSearchResult>,
}

/// Connectivity/configuration check outcome returned by [`SearchProvider::test`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProviderTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Trait implemented by built-in, external, and plugin search providers.
#[async_trait]
pub trait SearchProvider: Send + Sync {
    /// Unique provider identifier (`"library"`, `"musicdeck-playlists"`, `"deezer"`, `"spotify"`).
    fn id(&self) -> &str;

    /// Display name shown in admin settings.
    fn name(&self) -> &str;

    /// Executes a search query and returns normalized [`UnifiedSearchResult`] records.
    async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<Vec<UnifiedSearchResult>, String>;

    /// Optional connectivity and credential diagnostic probe.
    async fn test(&self) -> Result<SearchProviderTestResult, String> {
        Ok(SearchProviderTestResult {
            ok: true,
            status: Some(String::from("success")),
            message: Some(format!("{} is configured", self.name())),
        })
    }
}

/// Projects a library [`Track`] into a [`UnifiedSearchResult`].
#[must_use]
pub fn to_track_search_result(
    track: &Track,
    availability: Option<Availability>,
    sources: Option<Vec<SourceOption>>,
) -> UnifiedSearchResult {
    let count = sources
        .as_ref()
        .map(Vec::len)
        .or_else(|| availability.as_ref().map(|a| a.available_source_count))
        .unwrap_or(1)
        .max(1);
    let artwork = match (&track.artwork_id, &track.artwork_url) {
        (Some(id), Some(url)) if !id.is_empty() && !url.is_empty() => Some(ExternalArtworkRef {
            id: id.clone(),
            url: url.clone(),
        }),
        _ => None,
    };

    UnifiedSearchResult {
        item_type: SearchResultType::Track,
        id: track.id.clone(),
        title: track.title.clone(),
        subtitle: Some(track.artist_name.clone()),
        artist: Some(track.artist_name.clone()),
        artist_credits: track.artist_credits.clone().filter(|c| !c.is_empty()),
        album: Some(track.album_name.clone()),
        artwork,
        preview_url: None,
        provider: SearchProviderKind::Library,
        source: SearchResultSource {
            kind: String::from("library"),
            count,
            options: sources,
            external_available: None,
        },
        availability,
        identity: None,
        providers: None,
        in_library: Some(true),
        local_track_id: Some(track.id.clone()),
        local_album_id: None,
        metadata: SearchResultMetadata {
            source_server: track.source_server.clone(),
            audio_metadata: track.audio_metadata.clone(),
            genres: track.genres.clone(),
            normalization_gain_db: track.normalization_gain_db.filter(|v| v.is_finite()),
            loudness: track.loudness,
            duration_seconds: track.duration_seconds,
            year: track.year,
            artist_id: track.artist_id.clone(),
            album_id: track.album_id.clone(),
            ..SearchResultMetadata::default()
        },
        identity_hints: track.identity_hints.clone(),
    }
}

/// Projects a library [`Album`] into a [`UnifiedSearchResult`].
#[must_use]
pub fn to_album_search_result(
    album: &Album,
    availability: Availability,
    sources: Option<Vec<SourceOption>>,
) -> UnifiedSearchResult {
    let count = sources
        .as_ref()
        .map(Vec::len)
        .unwrap_or(availability.available_source_count)
        .max(1);
    let artwork = match (&album.artwork_id, &album.artwork_url) {
        (Some(id), Some(url)) if !id.is_empty() && !url.is_empty() => Some(ExternalArtworkRef {
            id: id.clone(),
            url: url.clone(),
        }),
        _ => None,
    };

    UnifiedSearchResult {
        item_type: SearchResultType::Album,
        id: album.id.clone(),
        title: album.name.clone(),
        subtitle: Some(album.artist_name.clone()),
        artist: Some(album.artist_name.clone()),
        artist_credits: None,
        album: None,
        artwork,
        preview_url: None,
        provider: SearchProviderKind::Library,
        source: SearchResultSource {
            kind: String::from("library"),
            count,
            options: sources,
            external_available: None,
        },
        availability: Some(availability),
        identity: None,
        providers: None,
        in_library: Some(true),
        local_track_id: None,
        local_album_id: Some(album.id.clone()),
        metadata: SearchResultMetadata {
            year: album.year,
            source_server: album.source_server.clone(),
            song_count: Some(album.song_count),
            artist_id: album.artist_id.clone(),
            ..SearchResultMetadata::default()
        },
        identity_hints: album.identity_hints.clone(),
    }
}

/// Projects a library [`Artist`] into a [`UnifiedSearchResult`].
#[must_use]
pub fn to_artist_search_result(
    artist: &Artist,
    availability: Availability,
    sources: Option<Vec<SourceOption>>,
) -> UnifiedSearchResult {
    let count = sources
        .as_ref()
        .map(Vec::len)
        .unwrap_or(availability.available_source_count)
        .max(1);
    let artwork = match (&artist.artwork_id, &artist.artwork_url) {
        (Some(id), Some(url)) if !id.is_empty() && !url.is_empty() => Some(ExternalArtworkRef {
            id: id.clone(),
            url: url.clone(),
        }),
        _ => None,
    };

    UnifiedSearchResult {
        item_type: SearchResultType::Artist,
        id: artist.id.clone(),
        title: artist.name.clone(),
        subtitle: Some(String::from("Artist")),
        artist: Some(artist.name.clone()),
        artist_credits: None,
        album: None,
        artwork,
        preview_url: None,
        provider: SearchProviderKind::Library,
        source: SearchResultSource {
            kind: String::from("library"),
            count,
            options: sources,
            external_available: None,
        },
        availability: Some(availability),
        identity: None,
        providers: None,
        in_library: None,
        local_track_id: None,
        local_album_id: None,
        metadata: SearchResultMetadata {
            song_count: Some(artist.album_count),
            ..SearchResultMetadata::default()
        },
        identity_hints: artist.identity_hints.clone(),
    }
}

/// Projects a MusicDeck [`Playlist`] into a [`UnifiedSearchResult`].
#[must_use]
pub fn to_playlist_search_result(playlist: &Playlist) -> UnifiedSearchResult {
    let artwork = match (&playlist.artwork_id, &playlist.artwork_url) {
        (Some(id), Some(url)) if !id.is_empty() && !url.is_empty() => Some(ExternalArtworkRef {
            id: id.clone(),
            url: url.clone(),
        }),
        _ => None,
    };
    let subtitle = playlist
        .description
        .as_deref()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or("Playlist")
        .to_owned();

    UnifiedSearchResult {
        item_type: SearchResultType::Playlist,
        id: playlist.id.clone(),
        title: playlist.name.clone(),
        subtitle: Some(subtitle),
        artist: None,
        artist_credits: None,
        album: None,
        artwork,
        preview_url: None,
        provider: SearchProviderKind::Musicdeck,
        source: SearchResultSource {
            kind: String::from("musicdeck"),
            count: 1,
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
            song_count: Some(playlist.song_count),
            ..SearchResultMetadata::default()
        },
        identity_hints: None,
    }
}

/// Groups a flat slice of [`UnifiedSearchResult`] records by [`SearchResultType`].
#[must_use]
pub fn group_search_results(items: Vec<UnifiedSearchResult>) -> UnifiedSearchGroups {
    let mut groups = UnifiedSearchGroups::default();
    for item in items {
        match item.item_type {
            SearchResultType::Track => groups.track.push(item),
            SearchResultType::Album => groups.album.push(item),
            SearchResultType::Artist => groups.artist.push(item),
            SearchResultType::Playlist => groups.playlist.push(item),
        }
    }
    groups
}

/// Projects [`UnifiedSearchGroups`] into the legacy `/api/search` top-level arrays
/// (`tracks`, `albums`, `artists`, `playlists`).
#[must_use]
pub fn to_legacy_search_response(groups: &UnifiedSearchGroups) -> Value {
    let is_local = |item: &&UnifiedSearchResult| {
        matches!(
            item.provider,
            SearchProviderKind::Library | SearchProviderKind::Musicdeck
        )
    };

    let tracks: Vec<Value> = groups
        .track
        .iter()
        .filter(is_local)
        .map(|item| {
            let mut obj = json!({
                "id": item.id,
                "providerId": item.id,
                "title": item.title,
                "artistId": item.metadata.artist_id,
                "artistName": item.artist.as_deref().unwrap_or("Unknown artist"),
                "albumId": item.metadata.album_id,
                "albumName": item.album.as_deref().unwrap_or("Unknown album"),
                "durationSeconds": item.metadata.duration_seconds,
                "trackNumber": Value::Null,
                "artworkId": item.artwork.as_ref().map(|a| &a.id),
                "artworkUrl": item.artwork.as_ref().map(|a| &a.url),
                "streamUrl": format!("/api/tracks/{}/stream", urlencoding::encode(&item.id)),
                "availability": item.availability,
                "sources": item.source.options,
            });
            if let Some(gain) = item.metadata.normalization_gain_db.filter(|v| v.is_finite()) {
                obj["normalizationGainDb"] = json!(gain);
            }
            if let Some(loudness) = &item.metadata.loudness {
                obj["loudness"] = json!(loudness);
            }
            obj
        })
        .collect();

    let albums: Vec<Value> = groups
        .album
        .iter()
        .filter(is_local)
        .map(|item| {
            json!({
                "id": item.id,
                "providerId": item.id,
                "name": item.title,
                "artistId": item.metadata.artist_id,
                "artistName": item.artist.as_deref().unwrap_or("Unknown artist"),
                "year": item.metadata.year,
                "songCount": item.metadata.song_count.unwrap_or(0),
                "durationSeconds": Value::Null,
                "artworkId": item.artwork.as_ref().map(|a| &a.id),
                "artworkUrl": item.artwork.as_ref().map(|a| &a.url),
                "availability": item.availability,
                "sources": item.source.options,
            })
        })
        .collect();

    let artists: Vec<Value> = groups
        .artist
        .iter()
        .filter(is_local)
        .map(|item| {
            json!({
                "id": item.id,
                "providerId": item.id,
                "name": item.title,
                "albumCount": item.metadata.song_count,
                "artworkId": item.artwork.as_ref().map(|a| &a.id),
                "artworkUrl": item.artwork.as_ref().map(|a| &a.url),
                "availability": item.availability,
                "sources": item.source.options,
            })
        })
        .collect();

    let playlists: Vec<Value> = groups
        .playlist
        .iter()
        .filter(is_local)
        .map(|item| {
            json!({
                "id": item.id,
                "name": item.title,
                "description": item.subtitle,
                "songCount": item.metadata.song_count.unwrap_or(0),
                "artworkId": item.artwork.as_ref().map(|a| &a.id),
                "artworkUrl": item.artwork.as_ref().map(|a| &a.url),
            })
        })
        .collect();

    json!({
        "tracks": tracks,
        "albums": albums,
        "artists": artists,
        "playlists": playlists,
    })
}
