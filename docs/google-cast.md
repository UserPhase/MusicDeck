# Google Cast playback

The **Cast** control in both player layouts sends local-library audio to a
Google Cast receiver using Google's default media receiver. It is separate from
the account's **Devices** WebSocket controls and from trusted server extensions.

## Playback sequence

```text
User -> Cast button: consent to load Google's Sender SDK
Browser -> SDK: select receiver / establish session
PlaybackEngine: cancel local transitions, release local decks, retain queue/position
Browser -> MusicDeck: authenticated POST /api/v1/cast/ticket (library ID + quality)
MusicDeck -> browser: track-only capability URL + source/output MIME
SDK -> receiver: load capability URL, music metadata, exact position, autoplay
Receiver -> MusicDeck: cookie-free GET/HEAD with optional byte Range
Receiver -> sender: playback state/time; PlaybackEngine -> existing queue events
```

The browser retains queue ordering, repeated-entry identity, shuffle and repeat.
Receiver completion advances that same queue, not a second queue implementation.
Play/pause, seek and volume route to the receiver. Receiver time is sampled every
250 ms; physical receiver volume is reflected in MusicDeck's perceptual slider.
Rapid loads are serialized and stale occurrence progress is ignored.

Local audio is silenced before a receiver load. Local crossfade, gapless decode,
ReplayGain and silence trimming are not applied on the receiver, and no local
upcoming audio is prefetched while casting. The receiver owns decoding and track
boundaries; this is not sample-accurate gapless Cast playback. Quality badges do
not report the browser's decoder as the receiver's pipeline.

Stopping Cast stops its receiver session and restores a **paused** local deck at
the latest known fractional position. Receiver loss never automatically starts
local audio, because the receiver may still have buffered audio. Stop or confirm
the receiver's state before selecting local playback. Explicitly stop Cast before
a WebSocket playback handoff; a Cast sender cannot silently prepare another
Cast receiver as if it were a local HTML audio deck.

Keep the sender tab awake/open for automatic queue advancement. There is no
autonomous receiver-side queue or background browser execution guarantee.

## Deployment and formats

- Use a supported Chromium browser and a secure context. Unsupported browsers
  show a disabled control with an explanation; they load no external SDK.
- `MUSICDECK_PUBLIC_URL` must be the externally usable origin reachable **from
  the receiver**, not a container name or `localhost`. Use HTTPS with a
  certificate trusted by the receiver. Confirm LAN DNS, routing and firewall
  access from the receiver's network, including VLANs.
- The receiver must reach MusicDeck without browser-only cookies, SSO challenge
  pages or a browser-only VPN. Exempt only the capability stream path from such
  outer authentication, not the rest of the API.
- Source MIME is resolved on the server, not guessed from lossy UI metadata.
  Original/direct uses provider codec/container metadata. Unknown source formats
  are rejected with `CAST_FORMAT_UNKNOWN`; choose 128/256/320 kbps explicitly to
  request MP3 transcoding through Navidrome/Jellyfin. Receiver codec/sample-rate
  capabilities vary; there is no silent transcode fallback.
- The supplied nginx policy permits Google's sender scripts/frames. Operators
  with a custom CSP need equivalent `script-src` permission for
  `https://www.gstatic.com` and `https://www.google.com`, and `frame-src`
  permission for `https://www.google.com`.
- Local-Only blocks SDK initialization, capability issuance and receiver
  requests. Existing leases are revoked immediately when that policy changes.
  Merely opening MusicDeck does not connect to Google: the SDK is lazy and
  requires a Cast-button confirmation.
  Enabling Local-Only stops an active Cast session, but JavaScript already
  loaded from Google cannot be safely unloaded from a live page. Reload the
  page to remove that SDK entirely; the UI explicitly reports this boundary.
- SDK receiver reconnection is not automatic adoption of another sender's
  playback. A newly mounted controller explicitly selects a receiver and loads
  MusicDeck's current queue.

## Capability security

`POST /api/v1/cast/ticket` requires the normal user session and accepts only a
library track ID and optional bitrate. The random 256-bit token grants access to
one track and fixed quality, not library listing, settings, arbitrary URLs or
provider credentials. Tokens are kept hashed in bounded, in-memory server state;
a server restart invalidates them. The URL is a bearer secret: do not copy it
into screenshots, analytics or external systems.

Leases expire after 24 hours and are tied to the issuing login session. Logout,
session revocation, user disabling, explicit stop and track replacement revoke
them. Each session may have eight leases; the server has a 4,096-lease cap and
permits four simultaneous receiver requests per lease. Audio requests participate
in the existing TaskManager media-stream resource budget. Revocation closes
active receiver responses; it cannot erase bytes already buffered on hardware.
Long pauses beyond the lease lifetime require stopping/reconnecting Cast.

The stream path `/api/v1/cast/stream?token=...` alone allows cross-origin
cookie-free GET/HEAD/OPTIONS and byte-range requests. Responses are `no-store`.
`DELETE /api/v1/cast/ticket` revokes a token only for its issuing session.
MusicDeck redacts query tokens in server request logs, and the supplied nginx
disables access logs for this exact path. **Outer proxies must also omit or
redact its query string**, and must not cache capability responses.

## Verification

Automated coverage uses a deterministic SDK/receiver implementation to verify
metadata, fractional start position, play/pause/seek/volume, rapid-skip races,
completion identity, failure cleanup, and unsupported/privacy-blocked browsers.
Engine tests verify exclusive output ownership and no local transition prefetch.
Backend integration tests verify cookie-free Range/CORS delivery, MIME selection,
session-owned revocation, expiry, limits and privacy changes.

Physical receiver discovery, receiver certificate trust, supported codecs and
actual speaker output still need an installation-specific Chromecast/speaker
smoke test; they cannot be certified by mocked SDK tests.
