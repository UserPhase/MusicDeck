# Setup, diagnostics and system recovery

Open **Admin → Setup & Recovery** (`/admin/setup-recovery`). Every API for this feature requires a currently authenticated administrator and rejects unexpected browser origins. The initial administrator password (`MUSICDECK_ADMIN_PASSWORD`) and a non-default `MUSICDECK_SESSION_SECRET` are still required to bootstrap a new deployment securely. Backend credentials can then be entered in the wizard; missing backend configuration no longer prevents this bootstrap server from starting.

## Setup and health checks

1. Select Navidrome or Jellyfin and enter the backend URL and credentials. Password/API-key fields are never populated from the server; leaving them blank retains their saved value. The server tests Navidrome's authenticated Subsonic ping, or Jellyfin's authenticated System Info endpoint. Requests have an eight-second deadline, bounded response bodies and no redirects.
2. Check server/container paths. The wizard tests directory access by creating, flushing and deleting a uniquely named probe. It checks the SQLite/configuration directory, music directory, acquisition staging, optional artwork directory, and backup directory. It also runs the configured spotDL and FFmpeg executables using argument arrays with no shell, and performs SQLite `quick_check`, foreign-key validation and a non-mutating write reservation.
3. Follow the report's fix instructions and complete setup. Missing optional download tools are warnings: streaming existing music does not depend on spotDL. Failed connection, required storage or database checks block setup completion. Setup can be rerun later without deleting user data.

Saved backend/path settings are written to `config.json` beside the configured SQLite database and take precedence over environment defaults for those fields. The listener host/port, public URL, database path, initial administrator bootstrap credentials and session secret remain deployment-owned. Saving configuration creates a safety backup and performs a controlled restart. A backend-type switch is supported only while the local catalog is empty; populated catalogs require a deliberate provider/library migration.

## Archive contents and online backup

A system archive is a `.tar.gz` file containing:

- `manifest.json`: format/version, timestamp, database schema fingerprint, payload byte sizes and SHA-256 hashes.
- `database.sqlite`: a consistent SQLite online-backup snapshot. MusicDeck-owned playlists, preferences, listening history, user accounts, provider/plugin settings, avatars, playlist artwork blobs and artwork metadata are included through their SQLite tables.
- `config.json`: effective backend configuration and configured music/staging paths, including backend credentials.
- `artwork/…`: supported image and JSON cache files from the optional server artwork directory beside SQLite. Symlinks are refused.

Raw music, acquisition temporary files, transcoded playback caches, browser IndexedDB downloads, browser-only state, installed extension packages, OS tools and the upstream Navidrome/Jellyfin databases are outside this archive. Back those up separately where required. Restoring MusicDeck never deletes or replaces raw audio files.

Creation calls [`better-sqlite3`'s online backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise), which uses [SQLite's Online Backup API](https://www.sqlite.org/backup.html). It does not copy the live database file or its WAL. The snapshot is checked before publication, files are hashed, and compression streams to a private temporary archive. Only a completed, flushed archive is renamed into the backup directory. The archive and configuration files use mode `0600`; new recovery directories use `0700` on POSIX.

Archives contain credentials and personal account data and are not encrypted. Download a private copy to another machine or backup store; a backup on the same volume does not protect against loss of that volume.

## Restore sequence and atomicity

1. Stream the upload to a private recovery directory. Validate the TAR manifest and allowlisted paths, reject links/devices/duplicates/traversal, enforce declared sizes and SHA-256 checks, and run full SQLite integrity/foreign-key checks. The schema fingerprint must match the running build's actual schema, not merely the version claimed by the archive. An active administrator account must exist. Sessions in the staged restore are revoked.
2. Respond with `202 Accepted`, then stop HTTP requests, active streams, scheduled work, extensions, acquisition workers and analysis services. Capture a fresh **pre-restore safety archive after the runtime is quiescent**, checkpoint the live database and close its handles.
3. Persist and flush a recovery journal before moving the original database/configuration/artwork aside. Promote the staged files on the same volume, then construct and start a fresh runtime. This recreates providers, caches and schedulers. Mark the journal committed only after startup succeeds.
4. On failure, stop any replacement runtime, restore the original files and restart the original system. On a process crash, the next normal startup processes an uncommitted journal **before reading config.json or opening SQLite**, discards replacement WAL sidecars, and rolls back the file set. A committed journal only needs cleanup. Recovery status records the outcome and retains the safety archive.

A filesystem cannot rename several independent files in a single atomic operation. MusicDeck provides recoverable atomicity through a maintenance barrier, durable journal, same-volume renames and rollback; it does not serve a mixed file set. POSIX directory fsync is used where available; Windows uses file flushes and same-volume renames. Durability still depends on the filesystem/storage device honoring flushes. Run one MusicDeck writer instance per database volume, and stop external SQLite writers before a restore.

Restoring signs everyone out. Log in using an administrator account from the restored archive, then inspect recovery status, download the safety archive if needed, and rerun health checks. A migration to another host may require updating server paths and backend endpoints in the wizard.

## Limits, scheduling and catastrophic recovery

- Maximum compressed upload/archive: **256 MiB**. Maximum expanded payload: **1 GiB**.
- Maximum payload files: **10,002**. Manifest: **2 MiB**. Configuration: **1 MiB**. Each artwork file: **16 MiB**.
- SQLite online snapshot creation has a two-minute deadline. Invalid or incompatible archives are rejected before live files are changed.
- Enable daily backups in the recovery view. While the server is running, the scheduler checks once per minute and creates a system archive when no system backup exists from the past 24 hours. Archives and safety snapshots are retained; monitor free space and manage retention/off-server copies externally.
- Restore an older archive using the MusicDeck build/schema that created it, then upgrade normally. Arbitrary database schemas or embedded SQL migrations are never accepted from an archive.
- If the current database is corrupt enough that the server cannot start, preserve its volume for investigation. Start a clean instance of the matching MusicDeck version with a fresh data directory and bootstrap administrator, mount the media separately, then restore the verified archive through Setup & Recovery.

Automated tests cover snapshots under live writes, retained media, session revocation, archive validation, concurrent-operation exclusion, rollback after installation and startup failures, startup journal recovery, daily scheduling, admin authorization, and the full HTTP setup/restart/restore lifecycle using isolated test data.
