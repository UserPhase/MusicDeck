//! Shared, immutable catalog windows for the paged library endpoints.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::{Available, CatalogListResult, CatalogService};
use crate::providers::{Album, ProviderError, Track};

const WINDOW_TTL: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub(crate) struct CatalogSnapshot<T> {
    pub items: Vec<Available<T>>,
    pub revision: String,
    pub degraded: bool,
    expires_at: Instant,
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
        }
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
