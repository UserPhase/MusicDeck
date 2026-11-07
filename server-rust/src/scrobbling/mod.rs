//! # External Scrobbling & Durable Outbox Queue (`scrobbling`)
//!
//! Exports protocol primitives (`protocol`), Last.fm Audioscrobbler 2.0 client
//! and MD5 signature generator (`lastfm`), ListenBrainz v1 REST client (`listenbrainz`),
//! and the SQLite transactional scrobble outbox service (`queue`).

pub mod lastfm;
pub mod listenbrainz;
pub mod protocol;
pub mod queue;

pub use lastfm::{LASTFM_ENDPOINT, LastFmCredentials, LastFmScrobbler, last_fm_signature};
pub use listenbrainz::{
    LISTENBRAINZ_BASE_URL, LISTENBRAINZ_MAX_ITEM_BYTES, ListenBrainzScrobbler,
    listenbrainz_payload,
};
pub use protocol::{
    FailureKind, MAX_RETRY_DELAY_MS, ProtocolResponse, SCROBBLE_MAX_RESPONSE_BYTES,
    SCROBBLE_REQUEST_TIMEOUT_MS, ScrobbleError, ScrobbleListen, ScrobbleProvider,
    build_scrobble_http_client, http_failure, protocol_request, retry_delay, validate_listen,
};
pub use queue::{
    LastFmConnectInput, SCROBBLE_JOB_LEASE_MS, SCROBBLE_MAX_ATTEMPTS, SCROBBLE_WORKER_INTERVAL_MS,
    ScrobbleConnectionError, ScrobbleConnectionStatus, ScrobbleDiagnosticItem,
    ScrobbleQueueService, qualifies_for_scrobble,
};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn computes_deterministic_lastfm_md5_signature_excluding_format_and_api_sig() {
        let mut params = BTreeMap::new();
        params.insert(String::from("method"), String::from("track.scrobble"));
        params.insert(String::from("api_key"), String::from("my_api_key"));
        params.insert(String::from("artist"), String::from("Daft Punk"));
        params.insert(String::from("track"), String::from("Digital Love"));
        params.insert(String::from("timestamp"), String::from("1700000000"));
        params.insert(String::from("format"), String::from("json"));
        params.insert(String::from("api_sig"), String::from("ignored"));

        let sig1 = last_fm_signature(&params, "shared_secret_123");
        params.remove("format");
        params.remove("api_sig");
        let sig2 = last_fm_signature(&params, "shared_secret_123");
        assert_eq!(sig1, sig2);
        assert_eq!(sig1.len(), 32);
    }

    #[test]
    fn enforces_scrobble_qualification_and_listenbrainz_payload_shape() {
        // Last.fm rejects tracks <= 30s or without known duration
        assert!(!qualifies_for_scrobble(
            ScrobbleProvider::Lastfm,
            25.0,
            Some(30.0)
        ));
        assert!(!qualifies_for_scrobble(
            ScrobbleProvider::Lastfm,
            250.0,
            None
        ));
        assert!(qualifies_for_scrobble(
            ScrobbleProvider::Lastfm,
            100.0,
            Some(180.0)
        ));

        // ListenBrainz accepts half-duration or 240s
        assert!(qualifies_for_scrobble(
            ScrobbleProvider::Listenbrainz,
            240.0,
            None
        ));

        let listen = ScrobbleListen {
            artist: String::from("Boards of Canada"),
            track: String::from("Roygbiv"),
            album: Some(String::from("Music Has the Right to Children")),
            listened_at: 1_700_000_000,
            duration: Some(148),
        };
        let payload = listenbrainz_payload(&listen).expect("valid listen payload");
        assert_eq!(payload["listen_type"], "single");
        assert_eq!(payload["payload"][0]["listened_at"], 1_700_000_000);
        assert_eq!(
            payload["payload"][0]["track_metadata"]["artist_name"],
            "Boards of Canada"
        );
    }
}
