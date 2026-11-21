//! Recording identity for ordered track collections shown in the UI.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::normalize_music_text;
use crate::providers::Track;

#[derive(Default)]
pub(crate) struct TrackDedup {
    ids: HashSet<String>,
    isrcs: HashSet<String>,
    recordings: HashSet<String>,
    by_title_artist: HashMap<(String, String), Vec<Recording>>,
}

struct Recording {
    isrc: String,
    musicbrainz: String,
    duration: Option<f64>,
}

fn code(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

impl TrackDedup {
    pub(crate) fn insert_track(&mut self, track: &Track) -> bool {
        let hints = track.identity_hints.as_ref();
        self.insert(
            &track.id,
            &track.title,
            track
                .artist_credits
                .as_deref()
                .and_then(|credits| credits.first())
                .map(|credit| credit.name.as_str())
                .unwrap_or(&track.artist_name),
            hints.and_then(|hints| hints.isrc.as_deref()),
            hints.and_then(|hints| hints.music_brainz_id.as_deref()),
            track.duration_seconds.map(f64::from),
        )
    }

    pub(crate) fn insert_history(&mut self, track: &Value) -> bool {
        let first_text = |paths: &[&str]| {
            paths.iter().find_map(|path| {
                track
                    .pointer(path)
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
        };
        let duration = ["/durationSeconds", "/duration", "/metadata/durationSeconds"]
            .iter()
            .find_map(|path| {
                track
                    .pointer(path)
                    .and_then(Value::as_f64)
                    .filter(|value| *value > 0.0)
            });
        self.insert(
            first_text(&["/id", "/trackId"]).unwrap_or_default(),
            first_text(&["/title"]).unwrap_or_default(),
            first_text(&["/artistCredits/0/name", "/artist", "/artistName"]).unwrap_or_default(),
            first_text(&["/identityHints/isrc", "/metadata/isrc", "/isrc"]),
            first_text(&[
                "/identityHints/musicBrainzId",
                "/metadata/musicBrainzId",
                "/musicBrainzId",
            ]),
            duration,
        )
    }

    fn insert(
        &mut self,
        id: &str,
        title: &str,
        artist: &str,
        isrc: Option<&str>,
        musicbrainz: Option<&str>,
        duration: Option<f64>,
    ) -> bool {
        if !id.is_empty() && !self.ids.insert(id.to_owned()) {
            return false;
        }
        let isrc = code(isrc);
        let musicbrainz = code(musicbrainz);
        if self.isrcs.contains(&isrc) || self.recordings.contains(&musicbrainz) {
            return false;
        }
        let title = normalize_music_text(Some(title));
        let artist = normalize_music_text(Some(artist));
        if !matches!(title.as_str(), "" | "unknown title" | "unavailable track")
            && !matches!(artist.as_str(), "" | "unknown artist")
        {
            let group = self.by_title_artist.entry((title, artist)).or_default();
            let duration = duration.filter(|value| *value > 0.0);
            let conflicts =
                |left: &str, right: &str| !left.is_empty() && !right.is_empty() && left != right;
            if group.iter().any(|seen| {
                !conflicts(&isrc, &seen.isrc)
                    && !conflicts(&musicbrainz, &seen.musicbrainz)
                    && duration
                        .zip(seen.duration)
                        .is_none_or(|(left, right)| (left - right).abs() <= 5.0)
            }) {
                return false;
            }
            group.push(Recording {
                isrc: isrc.clone(),
                musicbrainz: musicbrainz.clone(),
                duration,
            });
        }
        if !isrc.is_empty() {
            self.isrcs.insert(isrc);
        }
        if !musicbrainz.is_empty() {
            self.recordings.insert(musicbrainz);
        }
        true
    }
}
