//! Shared, immutable catalog windows for the paged library endpoints.

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use serde::Deserialize;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use tokio::sync::Mutex;

use super::{Available, CatalogListResult, CatalogService};
use super::track_dedup::TrackDedup;
use crate::providers::{Album, ProviderError, Track};

const WINDOW_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LibraryTrackSort {
    #[default]
    Custom,
    TitleAsc,
    TitleDesc,
    AlbumAsc,
    AlbumDesc,
    DurationAsc,
    DurationDesc,
}

pub(crate) fn library_search_text(value: &str) -> String {
    value.nfkd().filter(|character| !is_combining_mark(*character)).flat_map(char::to_lowercase).collect()
}

#[derive(Debug)]
pub(crate) struct CatalogSnapshot<T> {
    pub items: Vec<Available<T>>,
    pub revision: String,
    pub degraded: bool,
    expires_at: Instant,
    track_grid: OnceLock<(Vec<usize>, String)>,
    track_search: OnceLock<Vec<String>>,
}

impl<T> CatalogSnapshot<T> {
    fn new(mut result: CatalogListResult<T>, id: impl Fn(&T) -> &str) -> Self {
        let mut seen = HashSet::new();
        result
            .items
            .retain(|entry| seen.insert(id(&entry.item).to_owned()));
        let revision = catalog_revision(
            result.items.iter().map(|entry| id(&entry.item)),
            result.degraded,
        );
        Self {
            items: result.items,
            revision,
            degraded: result.degraded,
            expires_at: Instant::now() + WINDOW_TTL,
            track_grid: OnceLock::new(),
            track_search: OnceLock::new(),
        }
    }
}

impl CatalogSnapshot<Track> {
    pub(crate) fn track_search(&self) -> &[String] {
        self.track_search.get_or_init(|| self.items.iter().map(|track| {
            let item = &track.item;
            library_search_text(&format!("{} {} {} {}", item.title, item.artist_name, item.album_name,
                item.genres.as_deref().unwrap_or_default().join(" ")))
        }).collect())
    }

    pub(crate) fn unique_tracks(&self) -> (impl ExactSizeIterator<Item = &Available<Track>>, &str) {
        let (indices, revision) = self.track_grid.get_or_init(|| {
            let mut seen = TrackDedup::default();
            let indices: Vec<_> = self.items.iter().enumerate()
                .filter_map(|(index, track)| seen.insert_track(&track.item).then_some(index))
                .collect();
            let revision = catalog_revision(indices.iter().map(|&index| self.items[index].item.id.as_str()), self.degraded);
            (indices, revision)
        });
        (indices.iter().map(|&index| &self.items[index]), revision)
    }
}

// Hash the entire ordered window before slicing it. Identical refreshes retain the same revision.
pub(crate) fn catalog_revision<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    degraded: bool,
) -> String {
    let mut hash = Sha256::new();
    hash.update([u8::from(degraded)]);
    for id in ids {
        hash.update(id.len().to_be_bytes());
        hash.update(id.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

#[derive(Debug, Default)]
pub(crate) struct CatalogSnapshots {
    tracks: Mutex<Option<Arc<CatalogSnapshot<Track>>>>,
    albums: Mutex<Option<Arc<CatalogSnapshot<Album>>>>,
}

impl CatalogSnapshots {
    /// The last completed library window, available while playback continues.
    pub fn cached_tracks(&self) -> Option<Arc<CatalogSnapshot<Track>>> {
        self.tracks.try_lock().ok()?.clone()
    }

    pub async fn tracks(&self, catalog: &CatalogService) -> Arc<CatalogSnapshot<Track>> {
        let mut cache = self.tracks.lock().await;
        if let Some(current) = cache
            .as_ref()
            .filter(|value| value.expires_at > Instant::now())
        {
            return current.clone();
        }
        let next = Arc::new(CatalogSnapshot::new(catalog.list_tracks().await, |track| {
            &track.id
        }));
        *cache = Some(next.clone());
        next
    }

    pub async fn albums(
        &self,
        catalog: &CatalogService,
    ) -> Result<Arc<CatalogSnapshot<Album>>, ProviderError> {
        let mut cache = self.albums.lock().await;
        if let Some(current) = cache
            .as_ref()
            .filter(|value| value.expires_at > Instant::now())
        {
            return Ok(current.clone());
        }
        let next = Arc::new(CatalogSnapshot::new(
            catalog.list_albums(None).await?,
            |album| &album.id,
        ));
        *cache = Some(next.clone());
        Ok(next)
    }

    pub async fn invalidate(&self) {
        *self.tracks.lock().await = None;
        *self.albums.lock().await = None;
    }
}
