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

Users should be able to enjoy their music without needing to understand
which backend, provider, or integration supplied it.

---

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