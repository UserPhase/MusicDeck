# MusicDeck Product

## 1. Product Vision

MusicDeck is a self-hosted music platform designed to provide a polished,
modern music experience without sacrificing the flexibility and ownership
of self-hosted media.

The experience combines:

- the polish and discovery of Spotify
- the self-hosted philosophy of Jellyfin
- the music-server capabilities of Navidrome
- an extensible ecosystem of plugins and providers

Core idea:

> One beautiful music app, any source.

Browsing remembers library track filters, the last search and source filter,
visible page indices, and route-specific scroll depth on this device, separately
for each account. Returning to Tracks/Albums waits for virtual-list layout and
restores the visible window without first flashing the top of the collection.
Explore, search and album/playlist detail pages retain their scroll context too.
Explicit search links override the remembered query.

Continue Listening includes unfinished albums and playlists with a progress ring
and a **Resume from Track X - m:ss** action, also available on their detail pages.
Progress syncs to the account every five seconds during playback and on pause,
navigation or leaving the app. Other devices refresh on opening/focus and every
30 seconds while the shelf is visible. Resume restores the bookmarked track and
fractional timestamp in ordered playback, turning shuffle off; regular Play
retains its restart behavior. Playlist duplicate occurrences remain distinct
after reordering; removed bookmarked entries show an error rather than playing
another copy. Rings indicate position through the track sequence, not total
listening-time coverage. Accurate resume requires a seekable stream.

Finished checkpoints and checkpoints untouched for 30 days are removed
automatically. Recent-track recommendations remain the fallback when there are no
resumable collections. Offline checkpoint failures are shown explicitly; playback
continues normally, and pausing again retries the save.

Settings includes a Data Export manager with record counts and approximate file
sizes before downloading. Individual playlists can be saved as extended M3U8 or
XSPF; all owned/shared playlists can be downloaded together in ZIP. Listening
history exports to CSV, and favorites, hidden/recommendation feedback and ratings
export to JSON. A unified JSON or compressed ZIP account bundle includes these
artifacts, saved account settings, smart playlist rules and saved discoveries.
Other listeners' private data, audio files and login credentials are never included.

Portable playlist files use relative music paths when the backend exposes a path
inside the configured music root. Move the exported files to that root for playback
in another player. Unavailable paths fall back to MusicDeck stream links that
require authentication; these are not self-contained media downloads. Duplicate
tracks and unavailable entries remain in exported playlists. Legacy listens with
unknown client names or listening durations retain empty fields. CSV formula-like
text receives a protective apostrophe for spreadsheet safety.

Exports are live paginated reads, so avoid editing data during generation.
Save account settings before exporting; the existing preference backup continues
to cover unsaved/device-only preferences. The native browser download manager
reports transfer progress and failures. ZIP sizes are estimates and vary with
compression. Portable bundles are not currently an automatic restore/import format
and do not replace full server/database backups.

Shuffle offers Standard Shuffle (the existing behavior) and opt-in Smart
Shuffle in the main player and Settings. Smart Shuffle avoids tracks heard
within two hours, favors liked tracks by 1.5x, and reduces the weight of artists
heard in the last five tracks by 80%. The current track stays selected, queue
history stays navigable in its actual order, and recent/duplicate omissions are
reported. If no eligible tracks remain, recent tracks are not silently reused.
Explicit track selections and manual queue edits remain listener overrides.
The mode syncs to the account; device listening history is kept per user and
excluded from portable settings exports.

Album-Aware Playback is a separate, off-by-default setting. With shuffle off,
explicit album playback uses Album ReplayGain (when normalization is enabled),
keeps recorded leading/trailing pauses, and prefers gapless transitions between
consecutive album tracks even if the general transition setting is Crossfade or
Off. Missing album gain preserves the original level instead of applying
per-track normalization. Other queues and album-to-autoplay boundaries retain
the usual settings. Changing this policy preserves the current position and
paused state. The choice is saved locally and included in account settings and
portable settings backups.

The player's clickable quality badge opens an Audio Inspector in every layout.
Its source / stream / playback signal chain separates original-file metadata
from delivered audio and the browser's Web Audio processing. Lossless/24-bit
badges describe the output, never merely a lossless original being transcoded.
The inspector shows codec, container, encoded bitrate when known, sample rate,
bit depth, channels, conversion evidence, server downsampling and client gain.
Live delivery throughput is network transfer speed, not encoded audio bitrate.
Unknown values, previews and separately normalized assets are labelled honestly;
browser hardware device type/sample rate are not guessed.

Listeners can apply 128, 256 or 320 kbps caps, Original, or Direct passthrough
to the current track with a brief reload preserving its exact position and
paused/playing state. Direct bypasses server-normalized files, keeps client
ReplayGain, and preserves lossy originals as lossy rather than converting them
to FLAC. Caps are requests, not proof that the server transcoded. Preferences
persist locally and to the account and are included in settings backups.

Album detail pages offer a Local Editions switcher when the local artist
catalog contains matching Original, Deluxe, Remaster or other recognized
editions. Year and track counts help distinguish releases. Switching editions
opens that album without interrupting the currently playing queue; edition
lookups never search external catalogs and failures offer a retry.

Administrators have a unified Activity Center under Administration. It shows
live coordinated imports, catalog scans and registered analysis work, pending
jobs with editable priorities, server resource metrics, and searchable
finished/failed/cancelled history with expandable diagnostic tails. Pause/resume
and cancellation are cooperative and take effect at worker boundaries. A gentle
reconnecting indicator preserves the last known view during disconnections.
Clearing history requires confirmation and removes terminal task records and
diagnostics only, never library media or active work. Smart playlist previews
remain immediate queries rather than background jobs.

Explore supports a Preview → Save for later → Selective Import journey for
Deezer/iTunes tracks and albums. Save for later stores metadata in the listener's
private Saved Discoveries shelf without downloading audio. The shelf is available
from the main navigation and supports individual or selected imports, import
progress, removal, and an optional automatic cleanup of entries now in the
library. Removing a saved entry never deletes a library file. Offline/network
failures retain the current shelf and provide a retry action; bookmarks are
server-persisted, not an offline write queue.

Users should be able to enjoy their music without needing to understand
which backend, provider, or integration supplied it.

Static playlist editing supports click to select, Ctrl/Cmd+click to toggle,
and Shift+click to select a range across the full list, including offscreen
tracks. Checkboxes make selection available on touch devices. Explicit Play,
Enter and double-click still start playback. Duplicate songs are separate
playlist occurrences and can be edited independently.

Playlist detail pages also show a Recommended section based on the playlist's
artists, genres and moods. Library suggestions render first, followed by cached
external suggestions from the same and related artists. Six rows are shown at a
time; Refresh reveals another group. Existing playlist recordings and duplicate
suggestions are excluded. Library songs have an Add action; missing songs offer
an explicit Import action and available previews. Importing saves to the server
library; adding to the playlist remains a separate action after indexing.
Local-only policy keeps library suggestions available and suppresses external
lookups. Recommendation loading never delays the playlist itself.

A floating selection toolbar offers Select All/Deselect All, Add to Playlist,
Play Next, Queue All, Download Selected and Remove from Playlist. Adding follows
existing playlist deduplication rules; queue actions retain selected duplicates.
Download Selected downloads each distinct song once and reports partial failures.
Drag a selected track's grip to move the whole group; Alt+Up/Down or toolbar
Move Up/Down provide keyboard and touch alternatives. Reordering is immediate
while saving. Network failures restore the old order; edits made elsewhere show
a conflict and a Reload playlist action instead of overwriting another edit.
Unavailable library entries remain in the saved playlist. Batch removal asks
for confirmation and never deletes library files.

Library → Smart Playlists lets listeners define self-updating collections with
nested “all”/“any” conditions over title, artist, album, genre, release year,
BPM, MusicDeck play/skip counts, favorites and last-played time. The builder
previews matching counts and sample tracks before saving. Collection membership
is evaluated again for playback, while local metadata refreshes periodically or
after a library index scan. Never-played tracks are included by “not in the last
N days.” Smart playlists are private to their creator; deleting one removes only
the rules, not library tracks. Static playlists retain their existing behavior.

When local album covers are absent or fail to load, album shelves, recent
listening rows, and the player can display a matching iTunes/Deezer cover.
Album heroes first try every available child-track cover before external
lookups or the artwork placeholder, including when the root cover fails to load.
Known default-cover IDs and Navidrome's HTTP 200 default-cover image are rejected
before the hero renders, rather than waiting for a browser image error.
New Spotify playlist imports also save album folder artwork for the media
server's rescan and retain Spotify album-cover URLs locally as a display fallback.
Existing folder covers are preserved; unavailable artwork does not fail a song import.
Artist stories prefer media-server biographies and fall back to attributed
Wikipedia summaries through MusicDeck. These fallbacks enrich the display
without changing library identities, audio, or embedded metadata.

Home's Recently Added Songs and Discover Tracks are full-width, vertically
stacked sections. Album shelf cards stay transparent at rest, with a neutral
hover or keyboard-focus fill. Light-mode Now Playing lyrics use dark slate
text and a purple active-line highlight; queue details use high-contrast
secondary text.

Profile's Remove photo button and the Queue / Recently Played segmented
control use explicit theme-adaptive button fills and contrasting text,
including hover and selected states, rather than browser-default button
backgrounds. Both retain keyboard focus rings and subtle press feedback.

The Queue tab lets listeners drag the non-interactive part of a song row
with a mouse; desktop rows have no drag handles or right-side arrow buttons.
Touch input uses a dedicated right-side handle with a 44-pixel touch target while the
rest of the row remains scrollable. Hybrid devices adapt to the most recent
pointer input rather than viewport width. Keyboard users press Arrow Up/Down
on a focused row or handle; focus follows the song and positions are announced.
Dragging starts after 6 pixels of movement, shows an insertion line and subtle
row movement (disabled for reduced motion), and supports edge auto-scroll.
Escape cancels dragging without changing the queue. The current
track and played entries stay fixed; Recently Played remains read-only.
The queue shows 25 upcoming tracks initially, with a Show full queue control
for longer queues. Reordering changes playback order only, never the source
playlist, and does not restart audio or reset progress.

---

Large track and album libraries are windowed within the normal page scroller,
including compact track density and responsive album columns. Scrolling into
uncached pages shows space-preserving placeholders; network failures expose a
Retry action. Track playback still queues the complete selected collection,
not just visible or cached tracks. Cover images load lazily without changing
the reserved cover dimensions.

## 2. Product Goals

MusicDeck should:

- make self-hosted music feel as polished as commercial streaming services
- make personal music collections easy to explore
- unify music from multiple configured sources
- support powerful customization without making the default experience
  complicated
- provide a foundation for third-party extensions
- work well for both casual listeners and serious music collectors
- provide a consistent experience across web and Android

---

## 3. Target Users

### Local recommendation feedback and autoplay

Library track menus provide **More like this**, **Less like this**,
**Hide from recommendations**, and **Hide artist from recommendations**.
More like this queues eligible songs from the local library; negative feedback
changes future suggestions immediately. Hidden items are excluded, not merely
ranked lower. These actions do not delete media or alter manually chosen queues.

When autoplay is enabled, the player refills its upcoming queue from the current
song's local cluster and continues when that queue ends. Tracks played within
four hours and already queued songs are excluded. If nothing eligible remains,
playback stops rather than repeating excluded songs. Queue explanations show
why automatically suggested songs were chosen. No cloud recommendation account
or external metadata lookup is required.

### Casual self-hosted listener

Wants:

- simple music playback
- attractive UI
- easy browsing
- playlists
- search
- recommendations
- downloads/offline listening

Should not need to understand Navidrome, Jellyfin, APIs, providers, or plugins.

### Music collector

Wants:

- powerful library browsing
- advanced filters
- metadata
- quality information
- multiple versions/sources
- statistics
- organization tools
- smart playlists

### Power user / self-hoster

Wants:

- multiple servers
- multiple libraries
- plugins
- automation
- integrations
- custom themes/CSS
- configurable providers
- administration and access control

---

## 4. Core Product Principles

### Beautiful by default

The default experience should be polished without requiring customization.

### Simple on the surface

Advanced functionality should exist without forcing complexity onto normal
users.

### Source agnostic

Users should think about music, not providers.

The UI should not fundamentally change depending on whether music came from
Navidrome, Jellyfin, local storage, or an extension.

### Self-hosting first

MusicDeck should respect:

- user ownership
- privacy
- local infrastructure
- configurable deployment
- user control

### Extensible

New providers, integrations, recommendation systems, metadata sources, and
other functionality should be possible without constantly modifying the core
product.

### Consistent

The same track, album, artist, and playlist concepts should behave
consistently throughout the application.

### Fast

Large libraries should remain usable and responsive.

### Accessible

The application should be usable across different devices, screen sizes,
input methods, and accessibility needs.

---

## 5. Experience Direction

MusicDeck should feel closer to a premium commercial music application than
a technical media-management interface.

The interface should emphasize:

- artwork
- music discovery
- clear hierarchy
- smooth navigation
- responsive layouts
- excellent playback controls
- useful personalization
- contextual actions

Avoid making technical concepts unnecessarily prominent.

Technical information should be available when useful without dominating the
primary experience.

---

## 6. Primary Experience

The core user journey should be:

Discover
→ Browse
→ Choose
→ Play
→ Continue listening
→ Discover more

Important surfaces:

- Home
- Search
- Library
- Artist
- Album
- Track
- Playlist
- Queue
- Now Playing
- Downloads
- Statistics
- Settings

These should feel like parts of one product rather than separate utilities.

---

## 7. Home Experience

The Home screen is a personalized music destination rather than a static
library dashboard.

Potential sections include:

- Continue Listening
- Recently Played
- Recently Added
- Favorites
- Recommended
- Quick Mixes
- Personalized Mixes
- Forgotten Favorites
- Albums You Haven't Finished
- Related/Similar Music

Users should eventually be able to customize the order and visibility of
Home sections.

---

## 8. Universal Music Experience

MusicDeck should aim to present music through unified concepts:

Artist
Album
Track
Playlist
Source
Availability

A user should be able to discover and interact with music regardless of its
underlying provider.

For example, an album may be:

- in the user's library
- available through another configured source
- downloaded
- cached
- unavailable

The UI should communicate these states clearly without becoming technical.

---

## 9. Library and Discovery

MusicDeck should support both:

### Library-first behavior

Users can focus entirely on music they already have.

### Discovery-first behavior

Users can explore music beyond their existing collection when configured
sources support it.

### Hybrid behavior

Library content and additional available content appear together while
remaining visually distinguishable.

The product should make this feel like one coherent experience.

---

## 10. Personalization

MusicDeck should learn from user behavior where appropriate.

Potential personalization includes:

- listening history
- favorites
- ratings
- frequently played artists
- recently played music
- recommendations
- mixes
- smart playlists
- listening statistics

Personalization should enhance discovery rather than make the application
feel opaque or uncontrollable.

---

## 11. Customization

MusicDeck should provide strong customization while maintaining a good
default experience.

Native customization may include:

- themes
- dark/light/AMOLED modes
- layout preferences
- player styles
- accent colors
- artwork treatment
- custom CSS

Advanced customization should be optional.
Each listener can pick a Layout Style in Settings → Interface & Layout:

- **Spotify / Tidal** (the default): library sidebar, docked Now Playing
  panel and a bottom player bar.
- **Apple Music:** library sidebar with playback controls and search in the
  header, plus full-height lyrics and queue panels.
- **YouTube Music:** header navigation with a menu drawer, edge-to-edge
  content and a floating player that expands.
- **SoundCloud:** header navigation, a feed with a widget column (now
  playing, next up, recently played, playlists) and a full-width player bar.

Switching styles applies instantly and never interrupts playback. On screens
narrower than 768px, every style uses the same mobile layout: a menu drawer,
a mini player and bottom tabs.

Admins can rename the application under Admin → Appearance → Branding. The
new name appears in the header logo, the admin chrome and the browser tab
title.
Dropdowns and context menus use a shared dark glass surface (88% opacity,
16px backdrop blur, a subtle light border, and a deep shadow). Floating menus
render above page chrome, outside scrollable panels, with visible keyboard
focus, readable hover states, and distinct destructive actions. Browsers
without backdrop-filter support use an opaque dark surface.

---

## 12. Extensibility

MusicDeck should be a platform as well as an application.

Plugins may eventually extend:

- music sources
- catalogs
- metadata
- artwork
- lyrics
- recommendations
- AI
- imports
- scrobbling
- automation
- playback processing
- UI
- themes

The core product should provide the stable user experience while plugins
provide additional capabilities.

Plugins should not be required for the core music experience to feel complete.

Administrators can manage optional executable modules under **Admin > Plugins >
Server extensions**. Reviewed local installations can be scanned and enabled or
disabled without restarting the container. Trust confirmation, discovery issues,
activation errors and retryable cleanup are explicit. This is separate from
catalog/provider plugin manifests: server extensions execute trusted code with
the service account's privileges and are disabled by default. See
[server extensions](server-extensions.md) for installation and supported hooks.

---

## 13. Platform Strategy

### Web

The web client is the primary development platform initially.

It should establish:

- core UX
- navigation
- playback experience
- library experience
- server interaction
- customization
- plugin-facing UI patterns

### Android

Android should eventually provide a native mobile experience using the
same product concepts.

The Android app should feel like the same MusicDeck product rather than a
separate application.

---

## 14. Administration

MusicDeck includes an administrative experience for self-hosted deployments.

Administration should focus on:

- users
- permissions
- servers
- libraries
- integrations
- plugins
- configuration
- themes
- security

Administration should remain separate from the primary listening experience.

---

## 15. Privacy and Ownership

MusicDeck should prioritize user control.

The product should avoid unnecessary collection of personal data.

External services and integrations should be explicit and configurable.

Users should understand when a feature depends on an external provider.

---

## 16. Product Boundaries

MusicDeck is primarily a music experience.

Features should be evaluated based on whether they improve:

- listening
- discovery
- organization
- personalization
- playback
- self-hosting
- extensibility

Avoid adding unrelated functionality simply because it could technically fit
into the platform.

---

## 17. Future Direction

The product may eventually support:

- more music providers
- richer discovery
- advanced recommendation systems
- more plugin capabilities
- additional platforms
- richer social features
- advanced automation
- deeper music metadata
- more sophisticated personalization

These are product directions, not commitments.

Future ideas must not be treated as implemented functionality unless the
codebase or current project documentation confirms they are implemented.

---

## 18. Product Decision Framework

When considering a new feature, ask:

1. Does it improve the music experience?
2. Does it fit the self-hosted philosophy?
3. Does it simplify or unnecessarily complicate the user experience?
4. Should it be native functionality or a plugin?
5. Does it work consistently across supported sources?
6. Does it create long-term architectural or UX debt?
7. Is the value large enough to justify the complexity?

Prefer the solution that provides the most user value with the least
unnecessary complexity.

---

## 19. Product North Star

MusicDeck should feel like:

> Spotify's ease of use and discovery,
> with the ownership and flexibility of self-hosting,
> backed by a powerful extensible platform.

## Privacy and external integrations

Administrators can enable **Local-Only Mode** in Settings to disable managed
third-party requests for every user while retaining local browsing, native
artwork, playlists and playback. Explore displays “Local-Only Mode Enabled.
Outbound metadata services are offline.” and offers local browsing instead.
Search falls back to the library, and disabled external import actions disappear
from cards, context menus, saved discoveries and player controls.

Individual permissions cover metadata/previews, spotDL imports and external
artwork. Imports also require metadata and artwork permissions because the
downloader manages its own provider traffic. The master switch remembers those
individual choices. An environment-enforced policy is clearly marked read-only.
Clients synchronize policy automatically; temporary synchronization outages
disable external features without interrupting local playback.

## Installable web app and browser storage

MusicDeck can be installed as a PWA over HTTPS (or localhost). After one
successful production visit, its app shell can open without a network connection.
A persistent **Offline / Web mode** banner explains that sign-in and library
browsing still need the server; full offline playback is not guaranteed by the
web client. Only explicitly downloaded, audited track copies may be available.
No playing stream is automatically saved by the service worker.

Settings → **Offline Storage** shows browser-reported origin usage and total
quota, plus stored track-record count and audio-blob size. Quota is not free disk
space, and the browser may include padding or other applications on the same
origin. Unsupported metrics are labeled unavailable, not shown as zero.

- **Clear Cover Art Cache** removes artwork only.
- **Purge Stale Web Cache** removes cached catalog metadata and obsolete MusicDeck PWA cache versions while
  retaining the current app shell and explicit audio downloads.
- **Remove offline tracks** requires confirmation, stops active downloads and
  removes all stored audio records, including damaged records. Preferences and
  login remain unchanged.

Artwork expires after 30 days and is capped at 1,000 cached images. Browsers may
evict storage earlier; a downloaded badge is backed by the existing byte auditor,
not by a historical download flag. PWA updates wait for open tabs to close so
installing an update cannot unexpectedly interrupt playback.

### Playback devices

The **Devices** control in the player opens the account's live device list.
On each receiving browser, choose **Enable playback on this device** once per
tab, then keep that tab open. Device names can be changed for the current tab.
Selecting **Play here** prepares the destination silently while the current
device continues, then moves its ordered queue and fresh fractional position.
Repeated tracks, repeat mode, shuffle order/seed and collection progress are
preserved. Audio is fetched by the receiving device, not relayed through the
controller.

Play/pause, previous/next, seeking and volume control the active remote device.
Per-device volume is also available in the selector. The remote queue is edited
on its player or after transferring playback here; the controller does not
mislabel its retained local queue or quality diagnostics as remote data.
Selecting a new local track starts local playback and takes ownership again.

Only accessible local-library queues can transfer (at most 5,000 entries and
1 MiB of metadata). External previews, device-only media and unseekable live
streams do not transfer. A failed preparation leaves the source playing. If
the connection fails during final handoff, check both devices before resuming:
MusicDeck deliberately avoids an automatic fallback that could overlap players.
This is playback continuity, not sample-synchronized multi-room output. Sleeping,
closed or browser-suspended tabs cannot reliably receive control.

### Google Cast

The **Cast** control in both player layouts connects a supported Chromium browser
to a Google Cast speaker/receiver. Google SDK loading requires explicit consent
and is disabled by Local-Only policy. Local-library queues, shuffle/repeat and
fractional position remain controlled by MusicDeck while audio, time, seek and
volume are routed to the receiver. External previews cannot be cast.

Local transitions and normalization do not run on the receiver. Cast keeps the
sender's queue, so keep its tab open and awake. Stopping restores local playback
paused; disconnection never automatically starts a second audible player.
Stop Cast before transferring between account devices. See
[Google Cast setup and limitations](google-cast.md).
