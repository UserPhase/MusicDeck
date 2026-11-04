# Playlist organization and recovery

Migration 41 adds personal nested folders, personal playlist placements/pins, a playlist `deleted_at` timestamp, edit revisions, and a bounded command journal. Folder and placement ownership is enforced by composite foreign keys and service checks. Moves reject cycles and trees deeper than 16 levels. Removing a folder moves its child folders and playlists up one level without deleting their contents.

Playlist deletion moves the MusicDeck record to Trash. Entries, artwork and organization survive until restoration or expiry. Normal lists, searches, exports and resume checkpoints exclude Trash. The server purges expired records in bounded batches at startup and hourly while running. Recovery is available for 30 rolling days; an expired record cannot be restored even before the maintenance job reaches it. Provider tombstones prevent permanently removed playlists from being silently imported again. Trashing does not delete provider media or destroy the upstream playlist needed for recovery.

`server/src/domain/playlist-organization.ts` stores forward/inverse commands in SQLite. Reordering records exact occurrence IDs; removal retains only removed rows; batch addition records the new entry IDs. Undo therefore preserves duplicate occurrences and temporarily unavailable entries. Details edits and Trash/restore are reversible too. History retains up to 50 commands per user. The browser stack is session-scoped and clears on account changes or reload; Trash recovery survives app/server restarts.

Every command uses an expected revision and server-owned state fingerprints. SQLite triggers also advance revisions for legacy edit routes and background imports. Undo/redo rejects conflicting changes instead of replacing another tab's edits. Client requests include the expected account identity and abort on account changes. An uncertain network outcome clears affected client history and asks the listener to reload before retrying. Provider synchronization is coalesced, best effort, and does not hold the command response open; shutdown drains active synchronization before closing SQLite.

`webapp/src/hooks/usePlaylistUndo.ts` exposes execute, undo, redo, availability, busy/error state, and history through a shared external store. Existing playlist APIs use the command transport after authentication, so edits from track menus, recommendations and playlist details share one stack. The global toast survives navigation and offers Undo/Redo. Keyboard shortcuts are Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y; text fields and dialogs retain their own editing shortcuts.

`webapp/src/components/playlists/PlaylistFolderTree.tsx` replaces the flat sidebar list while retaining resolved covers, smart playlists and liked albums. Drag a playlist onto a folder, drag folders inside other folders, or drop a folder at the top edge of another row to reorder it. The root drop target moves items out of folders. Action menus expose equivalent move/pin/up/down controls, including touch-friendly destination selection. Arrow keys, Home/End and Enter navigate the tree; Shift+F10 opens actions. Personal sorting supports custom order, name and recent edits. Trash is a focus-trapped recovery dialog with explicit retention information.

Playlist detail search indexes title, artist, album and all genres locally, including accent folding and multi-word matching. React defers filtering to keep typing responsive. Reordering a filtered view retains the slots of nonmatching or unavailable entries. Filtered playback uses a collection context so it cannot overwrite full-playlist resume checkpoints.

Validation includes service tests for nesting, ownership, ordering, duplicate-safe multi-step undo/redo, conflicts, persistent Trash, artwork retention and the exact expiry boundary; hook and tree interaction tests; and acceptance Scenario 9 covering real browser drag/drop, inline search, undo/redo and restoration into a nested folder.

```sh
# Repository root
npm run test:acceptance:types
npm run test:acceptance -- --grep "Scenario 9"

# server/
npx vitest run test/playlist-organization.test.ts test/playlist-service.test.ts --maxWorkers=1
```
