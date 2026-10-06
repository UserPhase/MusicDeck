# MusicDeck Architecture

## 1. Purpose

MusicDeck is a self-hosted music application with:

- Spotify-inspired UX
- Navidrome as the primary music backend
- Jellyfin-inspired server/library concepts
- Web and Android clients
- A planned extensible plugin system
- A unified model for music from different providers

Core principle:

> One beautiful music app, any source.

This document describes the current architecture and established
architectural decisions.

It is not a feature roadmap.

---

## 2. Repository Structure

```text
MusicDeck/
├── webapp/
│   └── React web client
├── android/
│   └── Android client
├── server/
│   └── MusicDeck API/server
├── docs/
│   └── Architecture and project documentation
└── .github/
    └── Copilot agents and repository configuration
```

---

## 3. Providers

MusicDeck treats music sources as providers behind the registry:

- **Navidrome** — primary provider; catalog, streaming, artwork, and
  favorites/playlist sync.
- **Jellyfin** — built-in provider (catalog + direct audio streaming +
  artwork). Favorites/playlist sync is not yet supported.

### Jellyfin connection

A Jellyfin connection is configured in `backend_connections` with
`type = "jellyfin"` and provider config `config_json`:

```json
{ "url": "http://jellyfin:8096", "apiKey": "<jellyfin-api-key>" }
```

Credentials may instead come from `JELLYFIN_URL` / `JELLYFIN_API_KEY`
environment variables. The API key authenticates via the `X-Emby-Token`
header and is never placed in URLs or logs.

Album detail responses expose `coverUrl` and `artworkUrl` using authenticated
MusicDeck artwork identities. Local artwork candidates are validated before
the response is returned, with coalesced checks, a 128-entry cache, and at most
five concurrent validations. Missing/default root covers inherit the first
genuine child cover (including external tracks), then exact-match iTunes/Deezer
metadata if no child artwork is available. Failed local artwork IDs accompany
the response so child candidates cannot reintroduce a rejected cover.
Validation/metadata network failures are logged and exposed as
`artworkResolutionFailed` without preventing the album itself from loading;
failed checks are not cached as authoritative missing-artwork results.
Spotify playlist imports persist canonical album covers in
`imported_album_artwork`, indexed by normalized album artist and album name
(case/accent/punctuation-insensitive, apostrophes removed). A Spotify album ID
is retained when supplied. The album API checks this durable cache before
network metadata searches after rejecting missing/default native artwork.
Matched and legacy imports publish `cover.jpg` and `folder.jpg` in the actual
audio destination directory before their batch library rescan. JPEG downloads
are restricted to HTTPS `i.scdn.co/image/...`, with no redirects, an eight-second
timeout and a 5 MB limit. Each file is flushed and atomically linked without
overwriting existing folder artwork; files use mode 0644 for backend readability.
Artwork failures are logged and retained as bounded import warnings without
failing downloaded tracks; persistence does not depend on CDN download success.
Navidrome HTTP 200 default images are detected by SHA-256 equality with that
connection's `al-0` image at the same requested size. Reads are limited to 5 MB
and five seconds; only fingerprints are cached, for five minutes and at most
eight sizes per connection. Servers without an `al-0` image retain normal
artwork behavior; unknown default images cannot be inferred from URLs alone.
The shared client resolver rejects known placeholder paths/IDs before rendering
and preserves supplied
HTTP(S) and application-relative URLs, proxies raw IDs, and tries root artwork,
nested album artwork, then all distinct child-track covers. Image error handlers
remain as a second line of defense for genuine covers that later fail to load.
Failures are scoped to the current media item and candidate list.
Local album covers remain preferred. Missing or failed covers can resolve
through the authenticated `/api/metadata/album-artwork` proxy using exact
normalized artist and album matches from iTunes or Deezer. Lookups are
bounded and cached; CDN hosts, redirects, content types, and image sizes are
validated. This display-only fallback never rewrites embedded tags.
Wikipedia artist biographies use `/api/metadata/artist-biography` rather
than browser cross-origin requests, with cached musical-article validation
and source attribution. Native biographies retain priority.

Current Jellyfin support: catalog browsing, search, random albums/tracks,
artwork, and **direct-play streaming only** (no transcoding). Both Navidrome
and Jellyfin connections may be enabled simultaneously; the catalog service
fans reads out across them and the source resolver picks a playable source.