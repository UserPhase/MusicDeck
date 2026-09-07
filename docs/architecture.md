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

Current Jellyfin support: catalog browsing, search, random albums/tracks,
artwork, and **direct-play streaming only** (no transcoding). Both Navidrome
and Jellyfin connections may be enabled simultaneously; the catalog service
fans reads out across them and the source resolver picks a playable source.