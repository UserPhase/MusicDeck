use std::sync::{Arc, RwLock};
use std::time::Duration;

use http::StatusCode;

use super::{
    Album, Artist, LibraryScanResult, MusicBackend, Playlist, ProviderError, RegisteredProvider,
    SearchPagination, SearchResult, StreamResult, Track,
};

struct MediaFixture<F> {
    reply: F,
    catalog: Option<Arc<RwLock<CatalogFixture>>>,
    playlist: Option<Playlist>,
}

#[derive(Default)]
pub(crate) struct CatalogFixture {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
}

impl<F> std::fmt::Debug for MediaFixture<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaFixture")
    }
}

/// Registers a media-only test backend with a scripted response and header delay.
pub(crate) fn provider(
    id: &str,
    reply: impl Fn(&str, Option<&str>, Option<&str>, Option<u32>) -> (Duration, StreamResult)
    + Send
    + Sync
    + 'static,
) -> RegisteredProvider {
    RegisteredProvider {
        connection_id: id.to_owned(),
        provider_type: "navidrome".to_owned(),
        name: id.to_owned(),
        enabled: true,
        provider: Arc::new(MediaFixture {
            reply,
            catalog: None,
            playlist: None,
        }),
    }
}

pub(crate) fn catalog_provider(
    id: &str,
    catalog: Arc<RwLock<CatalogFixture>>,
) -> RegisteredProvider {
    RegisteredProvider {
        connection_id: id.into(),
        provider_type: "navidrome".into(),
        name: id.into(),
        enabled: true,
        provider: Arc::new(MediaFixture {
            reply: |_: &str, _: Option<&str>, _: Option<&str>, _: Option<u32>| {
                panic!("unexpected stream request to catalog fixture");
            },
            catalog: Some(catalog),
            playlist: None,
        }),
    }
}

pub(crate) fn playlist_provider(id: &str, playlist: Playlist) -> RegisteredProvider {
    RegisteredProvider {
        connection_id: id.into(),
        provider_type: "navidrome".into(),
        name: id.into(),
        enabled: true,
        provider: Arc::new(MediaFixture {
            reply: |_: &str, _: Option<&str>, _: Option<&str>, _: Option<u32>| {
                panic!("unexpected stream request to playlist fixture");
            },
            catalog: None,
            playlist: Some(playlist),
        }),
    }
}

pub(crate) fn response(
    status: StatusCode,
    headers: impl IntoIterator<Item = (http::header::HeaderName, &'static str)>,
    body: impl Into<reqwest::Body>,
) -> StreamResult {
    let mut builder = http::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let response = reqwest::Response::from(builder.body(body.into()).unwrap());
    StreamResult {
        status,
        headers: response.headers().clone(),
        response,
        audio_stream: None,
    }
}

// Emit the trait impl before async_trait expands the signatures of the stub methods.
macro_rules! media_fixture_impl {
    ($($name:ident($($arg:ident: $arg_type:ty),*) -> $output:ty;)*) => {
        #[async_trait::async_trait]
        impl<F> MusicBackend for MediaFixture<F>
        where
            F: Fn(&str, Option<&str>, Option<&str>, Option<u32>) -> (Duration, StreamResult)
                + Send
                + Sync,
        {
            fn provider_kind(&self) -> &'static str {
                "navidrome"
            }

            async fn fetch_stream(
                &self,
                track: &str,
                range: Option<&str>,
                if_range: Option<&str>,
                bitrate: Option<u32>,
            ) -> Result<StreamResult, ProviderError> {
                let (delay, response) = (self.reply)(track, range, if_range, bitrate);
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(response)
            }

            async fn list_playlists(&self) -> Result<Vec<Playlist>, ProviderError> {
                Ok(self.playlist.iter().cloned().collect())
            }

            async fn finalize_imported_playlist(
                &self, id: &str, name: &str, description: &str,
            ) -> Result<Option<Playlist>, ProviderError> {
                Ok(self.playlist.clone().filter(|playlist| playlist.provider_id == id).map(|mut playlist| {
                    playlist.name = name.into();
                    playlist.description = Some(description.into());
                    playlist
                }))
            }

            async fn list_albums(&self, limit: Option<u32>) -> Result<Vec<Album>, ProviderError> {
                let catalog = self.catalog.as_ref().expect("catalog fixture").read().unwrap();
                Ok(catalog.albums.iter().take(limit.unwrap_or(500) as usize).cloned().collect())
            }

            async fn list_all_albums(&self) -> Result<Vec<Album>, ProviderError> {
                Ok(self.catalog.as_ref().expect("catalog fixture").read().unwrap().albums.clone())
            }

            async fn get_album(&self, id: &str) -> Result<Option<Album>, ProviderError> {
                let catalog = self.catalog.as_ref().expect("catalog fixture").read().unwrap();
                Ok(catalog.albums.iter().find(|album| album.id == id).cloned())
            }

            async fn list_tracks(&self) -> Result<Vec<Track>, ProviderError> {
                Ok(self.catalog.as_ref().expect("catalog fixture").read().unwrap().tracks.clone())
            }

            async fn get_track(&self, id: &str) -> Result<Option<Track>, ProviderError> {
                let catalog = self.catalog.as_ref().expect("catalog fixture").read().unwrap();
                Ok(catalog.tracks.iter().find(|track| track.id == id).cloned())
            }

            $(
                async fn $name(&self, $($arg: $arg_type),*) -> Result<$output, ProviderError> {
                    panic!(concat!("unexpected media fixture call to ", stringify!($name)));
                }
            )*
        }
    };
}

media_fixture_impl! {
    get_album_tracks(_id: &str) -> Vec<Track>;
    get_artists() -> Vec<Artist>;
    get_artist(_id: &str, _include_info: bool) -> Option<Artist>;
    get_artist_albums(_id: &str) -> Vec<Album>;
    get_artist_tracks(_id: &str) -> Vec<Track>;
    get_artist_top_tracks(_id: &str, _limit: usize) -> Vec<Track>;
    get_track_file_path(_id: &str) -> Option<String>;
    get_lyrics(_id: &str) -> Option<String>;
    get_artist_biography_for_track(_id: &str) -> Option<String>;
    search(_query: &str, _types: &[&str], _page: Option<SearchPagination>) -> SearchResult;
    get_random_tracks(_limit: u32) -> Vec<Track>;
    get_random_albums(_limit: u32) -> Vec<Album>;
    request_library_rescan() -> ();
    scan_library() -> LibraryScanResult;
    fetch_artwork(_id: &str, _size: Option<u32>) -> StreamResult;
}
