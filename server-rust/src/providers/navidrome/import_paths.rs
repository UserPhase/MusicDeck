use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::ImportedTrackMatch;

#[derive(Default)]
enum Candidate {
    #[default]
    Missing,
    Unique(String),
    Ambiguous,
}

impl Candidate {
    fn observe(&mut self, id: &str) {
        match self {
            Self::Missing => *self = Self::Unique(id.to_owned()),
            Self::Unique(current) if current != id => *self = Self::Ambiguous,
            _ => {}
        }
    }
}

#[derive(Default)]
struct PathCandidates {
    exact: Candidate,
    suffix: Candidate,
}

/// Stores only candidates for this import. Provider songs are streamed through one page at a time.
pub(super) struct ImportPathIndex<'a> {
    root: Option<String>,
    windows_root: bool,
    requested: Vec<(&'a str, usize)>,
    by_path: HashMap<String, usize>,
    by_windows_path: HashMap<String, Vec<usize>>,
    candidates: Vec<PathCandidates>,
    exact_claims: HashMap<String, Option<usize>>,
    suffix_claims: HashMap<String, Option<usize>>,
}

impl<'a> ImportPathIndex<'a> {
    pub(super) fn new(root: &Path, requested: &HashSet<&'a str>) -> Self {
        let root = root
            .to_str()
            .and_then(normalize)
            .filter(|path| absolute(path));
        let windows_root = root.as_deref().is_some_and(windows);
        let mut index = Self {
            root: root.map(|path| {
                if windows_root {
                    path.to_lowercase()
                } else {
                    path
                }
            }),
            windows_root,
            requested: Vec::with_capacity(requested.len()),
            by_path: HashMap::with_capacity(requested.len()),
            by_windows_path: HashMap::new(),
            candidates: Vec::with_capacity(requested.len()),
            exact_claims: HashMap::new(),
            suffix_claims: HashMap::new(),
        };
        for &original in requested {
            let Some(path) = normalize(original).filter(|path| !absolute(path)) else {
                continue;
            };
            let key = if windows_root {
                path.to_lowercase()
            } else {
                path
            };
            let slot = *index.by_path.entry(key.clone()).or_insert_with(|| {
                let slot = index.candidates.len();
                index.candidates.push(PathCandidates::default());
                if !windows_root {
                    index
                        .by_windows_path
                        .entry(key.to_lowercase())
                        .or_default()
                        .push(slot);
                }
                slot
            });
            index.requested.push((original, slot));
        }
        index
    }

    pub(super) fn is_empty(&self) -> bool {
        self.requested.is_empty()
    }

    pub(super) fn observe(&mut self, raw_path: &str, id: &str) {
        let Some(path) = normalize(raw_path) else {
            return;
        };
        let case_insensitive = self.windows_root || windows(&path);
        let path = if case_insensitive {
            path.to_lowercase()
        } else {
            path
        };
        if !absolute(&path) {
            self.record(&path, id, true, case_insensitive);
            return;
        }
        // A path under a known root is authoritative, including when its relative path
        // does not match. It must never fall through to an unrelated suffix.
        let relative = self
            .root
            .as_deref()
            .and_then(|root| strip_root(&path, root))
            .or_else(|| strip_root(&path, "/music"));
        if let Some(relative) = relative {
            self.record(relative, id, true, case_insensitive);
        } else {
            for (separator, _) in path.match_indices('/') {
                self.record(&path[separator + 1..], id, false, case_insensitive);
            }
        }
    }

    fn record(&mut self, key: &str, id: &str, exact: bool, case_insensitive: bool) {
        let slots = if case_insensitive && !self.windows_root {
            self.by_windows_path.get(key).map_or(&[][..], Vec::as_slice)
        } else {
            self.by_path.get(key).map_or(&[][..], std::slice::from_ref)
        };
        let claims = if exact {
            &mut self.exact_claims
        } else {
            &mut self.suffix_claims
        };
        for &slot in slots {
            let candidates = &mut self.candidates[slot];
            let candidate = if exact {
                &mut candidates.exact
            } else {
                &mut candidates.suffix
            };
            candidate.observe(id);
            if let Some(existing) = claims.get_mut(id) {
                if *existing != Some(slot) {
                    *existing = None;
                }
            } else {
                claims.insert(id.to_owned(), Some(slot));
            }
        }
    }

    pub(super) fn finish(self) -> HashMap<String, ImportedTrackMatch> {
        self.requested
            .into_iter()
            .filter_map(|(path, slot)| {
                let candidates = &self.candidates[slot];
                let outcome = match &candidates.exact {
                    Candidate::Unique(id) if self.exact_claims.get(id) == Some(&Some(slot)) => {
                        ImportedTrackMatch::Matched(id.clone())
                    }
                    Candidate::Unique(_) | Candidate::Ambiguous => ImportedTrackMatch::Ambiguous,
                    Candidate::Missing => match &candidates.suffix {
                        Candidate::Unique(id)
                            if self.suffix_claims.get(id) == Some(&Some(slot))
                                && !self.exact_claims.contains_key(id) =>
                        {
                            ImportedTrackMatch::Matched(id.clone())
                        }
                        Candidate::Unique(_) | Candidate::Ambiguous => {
                            ImportedTrackMatch::Ambiguous
                        }
                        Candidate::Missing => return None,
                    },
                };
                Some((path.to_owned(), outcome))
            })
            .collect()
    }
}

fn normalize(raw: &str) -> Option<String> {
    let slashes = raw.replace('\\', "/");
    if slashes.contains('\0') || slashes.starts_with("//./") {
        return None;
    }
    let (prefix, body) = if slashes
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
    {
        ("//", &slashes[8..])
    } else if let Some(body) = slashes.strip_prefix("//?/") {
        ("", body)
    } else if slashes.starts_with("//") && !slashes.starts_with("///") {
        ("//", slashes.trim_start_matches('/'))
    } else if slashes.starts_with('/') {
        ("/", slashes.trim_start_matches('/'))
    } else {
        ("", slashes.as_str())
    };
    let mut path = prefix.to_owned();
    for part in body
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        if part == ".." {
            return None;
        }
        if path.len() > prefix.len() {
            path.push('/');
        }
        path.push_str(part);
    }
    (!path.is_empty()).then_some(path)
}

fn windows(path: &str) -> bool {
    path.starts_with("//")
        || matches!(path.as_bytes(), [drive, b':'] | [drive, b':', b'/', ..] if drive.is_ascii_alphabetic())
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') || windows(path)
}

fn strip_root<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    if root == "/" {
        path.strip_prefix('/').filter(|path| !path.starts_with('/'))
    } else if path == root {
        Some("")
    } else {
        path.strip_prefix(root)?.strip_prefix('/')
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::NavidromeConfig,
        providers::{MusicBackend, NavidromeClient, ProviderError},
    };
    use axum::{
        Json, Router,
        extract::{Query, State},
        routing::get,
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    #[test]
    fn known_paths_win_and_unknown_mounts_require_an_unambiguous_full_suffix() {
        let requested = HashSet::from([
            "Artist/Album/exact.flac",
            "Artist/Album/unique.flac",
            "Artist/Album/ambiguous.flac",
            "Artist/Album/collision.flac",
            "Artist/Album/foreign.flac",
            "Artist/Album/case.flac",
            "Other/Artist/Album/shared.flac",
            "Artist/Album/shared.flac",
            "../Artist/Album/exact.flac",
        ]);
        let mut index = ImportPathIndex::new(Path::new("/srv/media"), &requested);
        for (path, id) in [
            ("/backup/Artist/Album/exact.flac", "wrong-exact"),
            ("/music/Artist/Album/exact.flac", "exact"),
            ("Artist/Album/exact.flac", "exact"),
            ("/mnt/a/Artist/Album/unique.flac", "unique"),
            ("/mnt/a/Artist/Album/ambiguous.flac", "ambiguous-1"),
            ("/mnt/b/Artist/Album/ambiguous.flac", "ambiguous-2"),
            ("/srv/media/Artist/Album/collision.flac", "collision-1"),
            ("Artist/Album/collision.flac", "collision-2"),
            ("/srv/media/other/Artist/Album/foreign.flac", "foreign"),
            ("/music/other/Artist/Album/foreign.flac", "foreign"),
            ("/foreign/notArtist/Album/foreign.flac", "wrong-boundary"),
            ("/srv/media/Artist/Album/CASE.flac", "case"),
            ("/mnt/Other/Artist/Album/shared.flac", "shared"),
        ] {
            index.observe(path, id);
        }
        let matches = index.finish();
        assert_eq!(
            matches.get("Artist/Album/exact.flac"),
            Some(&ImportedTrackMatch::Matched("exact".into()))
        );
        assert_eq!(
            matches.get("Artist/Album/unique.flac"),
            Some(&ImportedTrackMatch::Matched("unique".into()))
        );
        for ambiguous in ["ambiguous.flac", "collision.flac", "shared.flac"] {
            assert_eq!(
                matches.get(&format!("Artist/Album/{ambiguous}")),
                Some(&ImportedTrackMatch::Ambiguous)
            );
        }
        assert_eq!(
            matches.get("Other/Artist/Album/shared.flac"),
            Some(&ImportedTrackMatch::Ambiguous)
        );
        for missing in [
            "Artist/Album/case.flac",
            "Artist/Album/foreign.flac",
            "../Artist/Album/exact.flac",
        ] {
            assert!(!matches.contains_key(missing));
        }
    }

    #[test]
    fn windows_drive_and_unc_paths_match_without_hiding_posix_case_collisions() {
        for (root, reported) in [
            (
                r"\\?\C:\Shared\Music",
                r"c:\shared\music\Artist\.\ALBUM\A.flac",
            ),
            (
                r"\\?\UNC\Server\Share\Music",
                r"\\server\SHARE\music\ARTIST\album\A.FLAC",
            ),
            (r"C:\", r"C:\artist\album\a.flac"),
        ] {
            let requested = HashSet::from(["artist/album/a.flac", r"artist\album\A.flac"]);
            let mut index = ImportPathIndex::new(Path::new(root), &requested);
            index.observe(reported, "windows");
            assert_eq!(
                index.finish().into_values().collect::<Vec<_>>(),
                vec![ImportedTrackMatch::Matched("windows".into()); 2]
            );
        }
        let requested = HashSet::from(["Artist/Album/a.flac", "Artist/Album/A.flac"]);
        let mut index = ImportPathIndex::new(Path::new("/srv/media"), &requested);
        index.observe(r"D:\shared\ARTIST\ALBUM\A.FLAC", "unknown-windows-mount");
        assert_eq!(
            index.finish().into_values().collect::<Vec<_>>(),
            vec![ImportedTrackMatch::Ambiguous; 2]
        );
    }

    #[derive(Clone)]
    struct BrowseFixture {
        songs: Arc<Vec<Value>>,
        offsets: Arc<Mutex<Vec<usize>>>,
        page_cap: usize,
        repeat_first_page: bool,
    }

    async fn browse(
        State(fixture): State<BrowseFixture>,
        Query(query): Query<HashMap<String, String>>,
    ) -> Json<Value> {
        assert_eq!(query["query"], "");
        assert_eq!(query["artistCount"], "0");
        assert_eq!(query["albumCount"], "0");
        let offset = query["songOffset"].parse::<usize>().unwrap();
        let size = query["songCount"].parse::<usize>().unwrap();
        assert_eq!(size, 500);
        fixture.offsets.lock().unwrap().push(offset);
        let start = if fixture.repeat_first_page { 0 } else { offset };
        let songs: Vec<_> = fixture
            .songs
            .iter()
            .skip(start)
            .take(size.min(fixture.page_cap))
            .collect();
        let page = if songs.is_empty() {
            json!({})
        } else {
            json!({"song":songs})
        };
        Json(json!({"subsonic-response":{"status":"ok", "searchResult3":page}}))
    }

    async fn serve_browse_fixture(
        songs: Vec<Value>,
        page_cap: usize,
        repeat_first_page: bool,
    ) -> (
        NavidromeClient,
        Arc<Mutex<Vec<usize>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let offsets = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new()
            .route("/rest/search3.view", get(browse))
            .with_state(BrowseFixture {
                songs: Arc::new(songs),
                offsets: offsets.clone(),
                page_cap,
                repeat_first_page,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = NavidromeClient::new(NavidromeConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            ..Default::default()
        })
        .unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (client, offsets, task)
    }

    #[tokio::test]
    async fn reconciles_1201_files_with_four_bulk_browse_requests() {
        let paths: Vec<_> = (0..1201)
            .map(|number| format!("Artist/Album/{number}.flac"))
            .collect();
        let requested = paths.iter().map(String::as_str).collect();
        let songs = paths.iter().enumerate().map(|(number, path)| json!({
            "id":format!("id-{number}"), "path":format!("/music/{path}"), "title":"Unrelated tags",
        })).collect();
        let (client, offsets, server) = serve_browse_fixture(songs, 500, false).await;
        let result = client
            .reconcile_imported_tracks(Path::new("/srv/media"), &requested)
            .await
            .unwrap();
        assert_eq!(result.len(), paths.len());
        for (number, path) in paths.iter().enumerate() {
            assert_eq!(
                result[path],
                ImportedTrackMatch::Matched(format!("id-{number}"))
            );
        }
        assert_eq!(*offsets.lock().unwrap(), [0, 500, 1000, 1201]);
        server.abort();
    }

    #[tokio::test]
    async fn bulk_browse_handles_clamped_pages_missing_paths_and_late_collisions() {
        let songs = vec![
            json!({"id":"first", "path":"/mount-a/Artist/Album/ambiguous.flac"}),
            json!({"id":"missing-path"}),
            json!({"id":"wrong-edition", "path":"/mount/Artist/Album/exact.flac"}),
            json!({"id":"second", "path":"/mount-b/Artist/Album/ambiguous.flac"}),
            json!({"id":"exact", "path":"/music/Artist/Album/exact.flac"}),
        ];
        let (client, offsets, server) = serve_browse_fixture(songs, 2, false).await;
        let requested = HashSet::from([
            "Artist/Album/ambiguous.flac",
            "Artist/Album/exact.flac",
            "Artist/Album/no-match.flac",
        ]);
        let result = client
            .reconcile_imported_tracks(Path::new("/srv/media"), &requested)
            .await
            .unwrap();
        assert_eq!(
            result["Artist/Album/ambiguous.flac"],
            ImportedTrackMatch::Ambiguous
        );
        assert_eq!(
            result["Artist/Album/exact.flac"],
            ImportedTrackMatch::Matched("exact".into())
        );
        assert!(!result.contains_key("Artist/Album/no-match.flac"));
        assert_eq!(*offsets.lock().unwrap(), [0, 2, 4, 5]);
        server.abort();
    }

    #[tokio::test]
    async fn bulk_browse_rejects_a_provider_that_repeats_its_first_page() {
        let (client, offsets, server) = serve_browse_fixture(
            vec![json!({"id":"id", "path":"Artist/Album/a.flac"})],
            1,
            true,
        )
        .await;
        let result = client
            .reconcile_imported_tracks(
                Path::new("/srv/media"),
                &HashSet::from(["Artist/Album/a.flac"]),
            )
            .await;
        assert!(matches!(
            result,
            Err(ProviderError::PaginationStalled {
                entity: "track",
                ..
            })
        ));
        assert_eq!(*offsets.lock().unwrap(), [0, 1]);
        server.abort();
    }
}
