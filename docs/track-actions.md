# Unified track actions and touch selection

`useTrackActions` owns shared queue, playlist, favorite, download, saved-music, and recommendation operations. `UniversalTrackContextMenu` consumes the same controller for one track and a selection.

Library Tracks, Search, Artist, Album, Playlists, Explore, Home, Liked Songs, listening history, and playlist recommendations now use collection-owned `TrackActionScope` selection. View-specific playlist menus have been removed. Playlist removal and reordering remain collection operations; shared menu commands use the controller.

## Interaction rules

- A single tap plays a track outside selection mode. Artist/album links and controls retain their normal behavior.
- A one-finger, 500 ms hold on the row body enters selection mode and selects that occurrence. The compatibility click generated after the hold is consumed once, including when a checkbox appears beneath the finger.
- Moving more than 10 CSS pixels, scrolling, another finger anywhere in the view, cancellation, loss of visibility/focus, a recycled row, or a collection change cancels the pending hold. Touch listeners do not prevent scrolling or pinch zoom. Links retain their native context menus and touch callouts.
- Select tracks enters the same mode explicitly. Checkboxes and row taps toggle individual occurrences; Done selecting and Clear selection return to ordinary playback. The mode remains active if the final checkbox is cleared, so another track can still be selected.
- Desktop playlist click/range/reorder behavior is retained. Other collections support Ctrl/Cmd-click and Shift-click; Ctrl/Cmd+A on a focused row selects that collection. Space selects, and Enter toggles in selection mode. Escape clears a focused collection selection or closes an open menu.
- Only one track menu opens at a time. Arrow keys, Home/End, Escape, and Tab work in the menu; disabled actions are skipped. Menu focus and focus restoration use `preventScroll`. Menus and the selection toolbar are portaled to the document body and do not lock page scrolling.

## Action semantics

Queue operations preserve selected order and intentional duplicate playlist occurrences. Mutations, imports, and device downloads deduplicate track IDs. Repeated additions to playlists use the existing atomic batch API, in groups of at most 500 IDs, so existing entries are not duplicated.

Toggle Favorites likes the entire selection unless every selected track is already liked, in which case it unlikes it. Partial failures identify failed tracks and preserve the original intent when retried, avoiding reversal of completed unlikes. The player exposes a rejecting `setTrackFavorite` operation so the controller can show failures instead of swallowing them.

Library Save for Later writes to a user-owned Saved for Later playlist. Its ID is kept in user settings; concurrent actions in the same browser share playlist creation. External Deezer/iTunes tracks use the existing Saved discoveries store. Unsupported external providers show an actionable error instead of pretending a bookmark was saved.

Library downloads enter the offline engine as an atomic batch before the menu reports them queued. The engine continues processing after navigation. An external download enters the existing server import queue; it is never labelled as an offline file. Favorites and playlist additions require a library track. Mixed selections are validated before these operations mutate anything. Existing privacy restrictions remain enforced for external imports.

Async actions freeze the intended targets. A collection/account change cancels unresolved selection loading. Once a batch starts, removing or recycling the invoking row does not cancel the remaining mutations for the same authenticated owner. Route navigation or an account change stops subsequent requests. In-flight server requests may already have completed. Batch errors report completed work and failures rather than claiming complete success.

## Virtualization and scroll

Selection keys identify occurrences in the collection and live outside mounted rows. Virtualization can unmount/recycle a row without losing its selection. Paged Library keys are invalidated when collection revision, filters, or deletions change. Selecting all does not enumerate or fetch every track during rendering.

When a batch action needs uncached selections, `usePagedLibrary.loadSelection` reads only the needed pages without replacing the visible page cache. It verifies the source revision and total before returning any targets. A changed collection aborts the operation rather than applying the action to shifted indices.

The existing `useRouteScrollRestoration` remains responsible for per-user route offsets and asynchronous virtual layout restoration. Opening/closing a menu does not overwrite those offsets. [Browser focus can scroll unless prevented](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus); menu focus explicitly prevents that side effect.

## Validation

Component/hook tests cover gesture timing, movement/scroll/multitouch cancellation, synthetic clicks, link propagation, virtual selection, row render isolation, partial failure recovery, account switches, playlist batching, download queue persistence, paging revision changes, and route scroll restoration.

Run the native Chromium touch check from `webapp`:

```powershell
npm run test:touch
```

Set `CHROME_PATH` if Chromium/Edge is not installed at a detected location. This check bundles the real components with isolated account/player fixtures, starts a localhost-only server, and uses a fresh headless browser profile. It exercises a 390 × 844 viewport with native touch events, draggable rows, long-press selection, batch Play Next order, scrolling, inline artist navigation, and exact return-scroll restoration. Temporary browser files are removed afterward. Set `MUSICDECK_TOUCH_SCREENSHOT_PATH` to save a screenshot.

No new runtime packages are required; the check uses the repository's existing esbuild and WebSocket dependencies.
