import type Database from "better-sqlite3";

import type { AppConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { createId } from "../utils/ids.js";

function smartActivityRefresh(table: "listening_events" | "recently_played", row: "NEW" | "OLD", taste = false) {
  const events = table === "listening_events";
  const columns = events ? "plays,skips,last_played" : "recent_plays,recent_last_played";
  const at = events ? "created_at" : "played_at";
  const aggregate = events
    ? `COUNT(CASE WHEN event_type IN ('play','complete') THEN 1 END),
       COALESCE(SUM(CASE WHEN event_type='skip' OR
         (event_type='progress' AND finished=1 AND listened_seconds>0) THEN 1 ELSE 0 END),0),
       MAX(CASE WHEN event_type IN ('play','complete','skip') OR listened_seconds>0
         THEN CAST(ROUND((julianday(${at})-2440587.5)*86400000) AS INTEGER) END)`
    : `COUNT(*),MAX(CAST(ROUND((julianday(${at})-2440587.5)*86400000) AS INTEGER))`;
  const updates = columns.split(",").map((column) => `${column}=excluded.${column}`).join(",");
  // During cascading user deletion the parent is already absent: don't recreate its summary.
  return `INSERT INTO smart_playlist_activity(user_id,track_id,${columns})
    SELECT ${row}.user_id,${row}.track_id,${aggregate} FROM ${taste ? `taste_${table}` : table}
    WHERE user_id=${row}.user_id AND track_id=${row}.track_id
    HAVING EXISTS(SELECT 1 FROM users WHERE id=${row}.user_id)
    ON CONFLICT(user_id,track_id) DO UPDATE SET ${updates};`;
}

function smartPlaylistActivitySchema(taste = false) {
  return `    CREATE TABLE IF NOT EXISTS smart_playlist_activity (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0, skips INTEGER NOT NULL DEFAULT 0, last_played INTEGER,
      recent_plays INTEGER NOT NULL DEFAULT 0, recent_last_played INTEGER,
      PRIMARY KEY(user_id,track_id)
    ) WITHOUT ROWID;
    INSERT INTO smart_playlist_activity(user_id,track_id,plays,skips,last_played)
      SELECT user_id,track_id,COUNT(CASE WHEN event_type IN ('play','complete') THEN 1 END),
        COALESCE(SUM(CASE WHEN event_type='skip' OR
          (event_type='progress' AND finished=1 AND listened_seconds>0) THEN 1 ELSE 0 END),0),
        MAX(CASE WHEN event_type IN ('play','complete','skip') OR listened_seconds>0
          THEN CAST(ROUND((julianday(created_at)-2440587.5)*86400000) AS INTEGER) END)
      FROM ${taste ? "taste_listening_events" : "listening_events"} GROUP BY user_id,track_id
      ON CONFLICT(user_id,track_id) DO UPDATE SET plays=excluded.plays,skips=excluded.skips,last_played=excluded.last_played;
    INSERT INTO smart_playlist_activity(user_id,track_id,recent_plays,recent_last_played)
      SELECT user_id,track_id,COUNT(*),MAX(CAST(ROUND((julianday(played_at)-2440587.5)*86400000) AS INTEGER))
      FROM ${taste ? "taste_recently_played" : "recently_played"} GROUP BY user_id,track_id
      ON CONFLICT(user_id,track_id) DO UPDATE SET recent_plays=excluded.recent_plays,recent_last_played=excluded.recent_last_played;
    ${(["listening_events", "recently_played"] as const).map((table) =>
      (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => `
        CREATE TRIGGER IF NOT EXISTS smart_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
          ${operation !== "INSERT" ? smartActivityRefresh(table, "OLD", taste) : ""}
          ${operation !== "DELETE" ? smartActivityRefresh(table, "NEW", taste) : ""}
        END;`).join("")).join("")}`;
}

type Migration = {
  id: number;
  name: string;
  sql: string | ((db: Database.Database) => void);
};

const migrations: Migration[] = [
  {
    id: 1,
    name: "initial-auth-and-backend-config",
    sql: `
      CREATE TABLE roles (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL REFERENCES roles(name),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE backend_connections (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "domain-ownership-settings-and-activity",
    sql: `
      ALTER TABLE users ADD COLUMN avatar_ref TEXT;

      CREATE TABLE user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE playlist_ownership (
        playlist_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, track_id)
      );

      CREATE TABLE recently_played (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        played_at TEXT NOT NULL
      );

      CREATE INDEX recently_played_user_played_at_idx
        ON recently_played(user_id, played_at DESC);
    `,
  },
  {
    id: 3,
    name: "connection-scoped-user-data-references",
    sql: `
      ALTER TABLE playlist_ownership
        ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'env-navidrome';

      CREATE TABLE favorites_new (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, connection_id, track_id)
      );

      INSERT INTO favorites_new (user_id, connection_id, track_id, created_at)
        SELECT user_id, 'env-navidrome', track_id, created_at FROM favorites;

      DROP TABLE favorites;
      ALTER TABLE favorites_new RENAME TO favorites;

      ALTER TABLE recently_played
        ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'env-navidrome';
    `,
  },
  {
    id: 4,
    name: "musicdeck-owned-playlists",
    sql: `
      CREATE TABLE playlists (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        source_connection_id TEXT,
        source_playlist_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE playlist_items (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        provider_track_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX playlist_items_playlist_position_idx
        ON playlist_items(playlist_id, position);

      INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
        SELECT
          'mdpl_' || playlist_id,
          owner_user_id,
          'Imported playlist',
          NULL,
          connection_id,
          playlist_id,
          created_at,
          updated_at
        FROM playlist_ownership;

      DROP TABLE playlist_ownership;
    `,
  },
  {
    id: 5,
    name: "stable-musicdeck-media-identities",
    sql: `
      CREATE TABLE library_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE library_item_sources (
        library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, provider_item_id, library_item_id)
      );

      CREATE INDEX library_item_sources_item_idx
        ON library_item_sources(library_item_id);
      CREATE UNIQUE INDEX library_item_sources_unique_source_idx
        ON library_item_sources(connection_id, provider_item_id, library_item_id);

      CREATE TABLE favorites_new (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, track_id)
      );

      INSERT INTO favorites_new (user_id, track_id, created_at)
        SELECT user_id, track_id, created_at FROM favorites;

      DROP TABLE favorites;
      ALTER TABLE favorites_new RENAME TO favorites;

      CREATE TABLE recently_played_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        played_at TEXT NOT NULL
      );

      INSERT INTO recently_played_new (id, user_id, track_id, played_at)
        SELECT id, user_id, track_id, played_at FROM recently_played;

      DROP TABLE recently_played;
      ALTER TABLE recently_played_new RENAME TO recently_played;

      CREATE INDEX recently_played_user_played_at_idx
        ON recently_played(user_id, played_at DESC);

      ALTER TABLE playlist_items
        ADD COLUMN library_track_id TEXT REFERENCES library_items(id) ON DELETE CASCADE;
    `,
  },
  {
    id: 6,
    name: "type-scoped-library-item-sources",
    sql: `
      -- Scope source mappings by item type so a Jellyfin item (whose artwork
      -- reference is its own item ID) can hold distinct identities for the
      -- item and its artwork under the same (connection, provider_item_id).
      CREATE TABLE library_item_sources_new (
        library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, provider_item_id, item_type, library_item_id)
      );

      INSERT INTO library_item_sources_new (library_item_id, item_type, connection_id, provider_item_id, created_at)
        SELECT s.library_item_id, i.type, s.connection_id, s.provider_item_id, s.created_at
        FROM library_item_sources s
        JOIN library_items i ON i.id = s.library_item_id;

      DROP TABLE library_item_sources;
      ALTER TABLE library_item_sources_new RENAME TO library_item_sources;

      CREATE INDEX library_item_sources_item_idx
        ON library_item_sources(library_item_id);
      CREATE UNIQUE INDEX library_item_sources_unique_source_idx
        ON library_item_sources(connection_id, provider_item_id, item_type, library_item_id);
    `,
  },
  {
    id: 7,
    name: "search-provider-configurations",
    sql: `
      CREATE TABLE search_provider_configs (
        provider_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      INSERT INTO search_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES
        ('library', 1, '{}', CURRENT_TIMESTAMP),
        ('musicdeck-playlists', 1, '{}', CURRENT_TIMESTAMP),
        ('itunes', 0, '{}', CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 8,
    name: "source-provider-configurations",
    sql: `
      CREATE TABLE source_provider_configs (
        provider_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES
        ('library', 1, '{}', CURRENT_TIMESTAMP),
        ('example-external', 0, '{}', CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 9,
    name: "external-source-permissions-and-itunes-preview",
    sql: `
      ALTER TABLE users ADD COLUMN external_search_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE users ADD COLUMN external_playback_enabled INTEGER NOT NULL DEFAULT 0;

      INSERT OR IGNORE INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES ('itunes-preview', 0, '{}', CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 10,
    name: "recommendation-signals-and-feedback",
    sql: `
      CREATE TABLE listening_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        completion_ratio REAL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX listening_events_user_created_idx
        ON listening_events(user_id, created_at DESC);
      CREATE INDEX listening_events_user_track_idx
        ON listening_events(user_id, track_id, created_at DESC);

      CREATE TABLE recommendation_feedback (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        action TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, item_type, item_id, action)
      );
    `,
  },
  {
    id: 11,
    name: "library-management-and-collections",
    sql: `
      CREATE TABLE media_ratings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, item_type, item_id)
      );

      CREATE TABLE media_favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, item_type, item_id)
      );

      CREATE TABLE saved_filters (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 12,
    name: "plugin-registry-state",
    sql: `
      CREATE TABLE plugin_configs (
        plugin_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        permissions_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 13,
    name: "custom-plugin-installations",
    sql: `
      CREATE TABLE custom_plugins (
        plugin_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 14,
    name: "on-demand-library-acquisitions",
    sql: `
      CREATE TABLE acquisition_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        source_provider TEXT,
        source_candidate_id TEXT,
        requested_track_id TEXT,
        requested_album_id TEXT,
        container_id TEXT,
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        percent REAL,
        files_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX acquisition_jobs_user_status_idx ON acquisition_jobs(user_id, status, created_at DESC);
      CREATE INDEX acquisition_jobs_container_idx ON acquisition_jobs(container_id);

      CREATE TABLE acquisition_containers (
        container_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        files_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 15,
    name: "downloader-adapter-and-realtime-events",
    sql: `
      ALTER TABLE acquisition_jobs ADD COLUMN auto_play INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE acquisition_jobs ADD COLUMN stage TEXT;
      ALTER TABLE acquisition_jobs ADD COLUMN speed_bytes_per_second INTEGER;
    `,
  },
  {
    id: 16,
    name: "silence-trim-analysis",
    sql: `
      CREATE TABLE track_silence_analysis (
        track_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        leading_silence_seconds REAL,
        trailing_silence_seconds REAL,
        duration_seconds REAL,
        threshold_db REAL NOT NULL,
        min_silence_seconds REAL NOT NULL,
        error_message TEXT,
        analyzed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 17,
    name: "spotify-external-catalog-provider",
    sql: `
      INSERT OR IGNORE INTO search_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES ('spotify', 0, '{}', CURRENT_TIMESTAMP);

      UPDATE search_provider_configs SET enabled = 0 WHERE provider_id = 'itunes';
    `,
  },
  {
    id: 18,
    name: "playlist-custom-artwork",
    sql: `
      CREATE TABLE playlist_artwork (
        playlist_id TEXT PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
        content_type TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 19,
    name: "keyless-external-preview-source",
    sql: `
      INSERT OR IGNORE INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES ('deezer-preview', 1, '{}', CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 20,
    name: "remove-lidarr-plugin-configuration",
    sql: "DELETE FROM plugin_configs WHERE plugin_id = 'lidarr';",
  },
  {
    id: 21,
    name: "persistent-spotify-import-jobs",
    sql: `
      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
        total_tracks INTEGER NOT NULL DEFAULT 0,
        completed_tracks INTEGER NOT NULL DEFAULT 0,
        failed_tracks INTEGER NOT NULL DEFAULT 0,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX import_jobs_status_idx ON import_jobs(status, created_at);
    `,
  },
  {
    id: 22,
    name: "imported-album-artwork",
    sql: `
      CREATE TABLE imported_album_artwork (
        id TEXT PRIMARY KEY,
        artist_name TEXT NOT NULL,
        album_name TEXT NOT NULL,
        spotify_album_id TEXT,
        cover_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (artist_name, album_name)
      );
      CREATE INDEX imported_album_artwork_spotify_idx ON imported_album_artwork(spotify_album_id);
    `,
  },
  {
    id: 23,
    name: "user-uploaded-avatars",
    sql: `
      ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

      CREATE TABLE user_avatars (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        content_type TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 24,
    name: "master-admin-and-login-activity",
    sql: `
      ALTER TABLE users ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN last_login_at TEXT;

      UPDATE users SET is_master = 1
      WHERE id = (
        SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1
      );

      UPDATE users SET last_login_at = (
        SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id
      );
    `,
  },
  {
    id: 25,
    name: "persistent-listening-activity",
    sql: `
      ALTER TABLE listening_events ADD COLUMN playback_session_id TEXT;
      ALTER TABLE listening_events ADD COLUMN listened_seconds REAL;
      ALTER TABLE listening_events ADD COLUMN duration_seconds REAL;
      ALTER TABLE listening_events ADD COLUMN counted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE listening_events ADD COLUMN finished INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE listening_events ADD COLUMN updated_at TEXT;
      ALTER TABLE listening_events ADD COLUMN track_json TEXT;
      ALTER TABLE listening_events ADD COLUMN artist_key TEXT;
      ALTER TABLE listening_events ADD COLUMN album_key TEXT;
      UPDATE listening_events SET counted = 1, finished = 1, updated_at = created_at
        WHERE event_type = 'complete';
      INSERT INTO listening_events (id, user_id, track_id, event_type, created_at, counted, finished, updated_at)
        SELECT 'history_' || r.id, r.user_id, r.track_id, 'complete', r.played_at, 1, 1, r.played_at
        FROM recently_played r
        WHERE NOT EXISTS (
          SELECT 1 FROM listening_events e WHERE e.user_id = r.user_id
            AND e.track_id = r.track_id AND e.event_type = 'complete'
            AND ABS(julianday(e.created_at) - julianday(r.played_at)) * 86400 < 5
        );
      CREATE UNIQUE INDEX listening_events_session_idx ON listening_events(user_id, playback_session_id)
        WHERE playback_session_id IS NOT NULL;
      CREATE INDEX listening_activity_history_idx ON listening_events(user_id, created_at DESC, id DESC)
        WHERE counted = 1;
    `,
  },
  {
    id: 26,
    name: "cached-playback-loudness",
    sql: `CREATE TABLE playback_loudness_cache (
      cache_key TEXT PRIMARY KEY,
      external INTEGER NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('flac', 'mp3')),
      integrated_lufs REAL NOT NULL,
      true_peak_db REAL NOT NULL,
      bytes INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );`,
  },
  {
    id: 27,
    name: "bounded-acquisition-retry-inputs",
    sql: `CREATE TABLE acquisition_job_inputs (
      job_id TEXT PRIMARY KEY REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
      input_json TEXT NOT NULL
    );
    CREATE INDEX acquisition_jobs_retention_idx ON acquisition_jobs(status, updated_at);`,
  },
  {
    id: 28,
    name: "live-playback-loudness-measurements",
    sql: `CREATE TABLE playback_loudness_measurements (
      cache_key TEXT PRIMARY KEY,
      measurement_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`,
  },
  {
    id: 29,
    name: "imported-audio-loudness",
    sql: `CREATE TABLE imported_audio_loudness (
      file_path TEXT PRIMARY KEY, music_root TEXT NOT NULL,
      file_size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
      title_key TEXT NOT NULL, artist_key TEXT NOT NULL, album_key TEXT NOT NULL,
      duration_seconds REAL NOT NULL, measurement_json TEXT NOT NULL
    );
    CREATE INDEX imported_audio_loudness_match ON imported_audio_loudness(title_key, artist_key, album_key);`,
  },
  {
    id: 30,
    name: "persistent-loudness-library-scans",
    sql: `CREATE TABLE loudness_scan_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, total_tracks INTEGER NOT NULL DEFAULT 0,
      completed_tracks INTEGER NOT NULL DEFAULT 0, skipped_tracks INTEGER NOT NULL DEFAULT 0,
      failed_tracks INTEGER NOT NULL DEFAULT 0, current_track TEXT, warning TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX loudness_scan_active ON loudness_scan_jobs((1)) WHERE status IN ('discovering', 'running');
    CREATE TABLE loudness_scan_tracks (
      job_id TEXT NOT NULL REFERENCES loudness_scan_jobs(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL, title TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(job_id, track_id)
    );
    CREATE INDEX loudness_scan_next ON loudness_scan_tracks(job_id, status, priority);`,
  },
  {
    id: 31,
    name: "persistent-silence-library-scans",
    sql: `ALTER TABLE loudness_scan_jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE silence_scan_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '{}', total_tracks INTEGER NOT NULL DEFAULT 0,
      completed_tracks INTEGER NOT NULL DEFAULT 0, skipped_tracks INTEGER NOT NULL DEFAULT 0,
      failed_tracks INTEGER NOT NULL DEFAULT 0, current_track TEXT, warning TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX silence_scan_active ON silence_scan_jobs((1)) WHERE status IN ('discovering', 'running');
    CREATE TABLE silence_scan_tracks (
      job_id TEXT NOT NULL REFERENCES silence_scan_jobs(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL, title TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(job_id, track_id)
    );
    CREATE INDEX silence_scan_next ON silence_scan_tracks(job_id, status, priority);
    CREATE TABLE track_silence_analysis_profiles (
      track_id TEXT NOT NULL, threshold_db REAL NOT NULL, min_silence_seconds REAL NOT NULL,
      revision TEXT NOT NULL, analysis_json TEXT NOT NULL,
      PRIMARY KEY(track_id, threshold_db, min_silence_seconds)
    );
    INSERT INTO track_silence_analysis_profiles
      SELECT s.track_id, s.threshold_db, s.min_silence_seconds, COALESCE(i.updated_at, ''),
        json_object('trackId', s.track_id, 'status', s.status,
          'leadingSilenceSeconds', s.leading_silence_seconds, 'trailingSilenceSeconds', s.trailing_silence_seconds,
          'durationSeconds', s.duration_seconds, 'thresholdDb', s.threshold_db, 'minSilenceSeconds', s.min_silence_seconds,
          'errorMessage', s.error_message, 'analyzedAt', s.analyzed_at, 'updatedAt', s.updated_at)
      FROM track_silence_analysis s LEFT JOIN library_items i ON i.id = s.track_id;`,
  },
  {
    id: 32,
    name: "saved-external-discoveries",
    sql: `CREATE TABLE saved_discoveries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('deezer', 'itunes')),
      external_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('track', 'album')),
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      cover_url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, provider, type, external_id)
    );
    CREATE INDEX saved_discoveries_user_created ON saved_discoveries(user_id, created_at DESC);`,
  },
  {
    id: 33,
    name: "smart-playlists-and-catalog-projection",
    sql: `CREATE TABLE smart_playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX smart_playlists_owner ON smart_playlists(user_id, updated_at DESC);
    CREATE TABLE smart_playlist_tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
      genre TEXT, year INTEGER, bpm REAL, revision TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE smart_playlist_track_payloads (
      track_id TEXT PRIMARY KEY REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
      track_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX smart_tracks_title ON smart_playlist_tracks(title COLLATE NOCASE, id);
    CREATE INDEX smart_tracks_year ON smart_playlist_tracks(year,genre,id);
    CREATE INDEX smart_tracks_bpm ON smart_playlist_tracks(bpm);
    CREATE TABLE smart_playlist_genres (
      track_id TEXT NOT NULL REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
      genre TEXT NOT NULL,
      PRIMARY KEY(track_id,genre)
    ) WITHOUT ROWID;
    CREATE INDEX smart_recent_user_track ON recently_played(user_id, track_id, played_at);
    CREATE TABLE smart_playlist_catalog_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), refreshed_at TEXT NOT NULL, degraded INTEGER NOT NULL
    );
    ${smartPlaylistActivitySchema()}`,
  },
  {
    id: 34,
    name: "listening-export-client",
    sql: "ALTER TABLE listening_events ADD COLUMN client_name TEXT;",
  },
  {
    id: 35,
    name: "resumable-media",
    sql: `CREATE TABLE media_sessions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK(media_type IN ('album','playlist')),
      media_id TEXT NOT NULL,
      title TEXT NOT NULL,
      track_id TEXT NOT NULL,
      occurrence_id TEXT,
      track_index INTEGER NOT NULL,
      track_count INTEGER NOT NULL,
      position_seconds REAL NOT NULL,
      duration_seconds REAL,
      progress REAL NOT NULL,
      captured_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,media_type,media_id)
    );
    CREATE INDEX media_sessions_expiry ON media_sessions(updated_at);
    CREATE TABLE media_session_completions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL,
      media_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,media_type,media_id)
    );
    CREATE INDEX media_session_completions_expiry ON media_session_completions(updated_at);`,
  },
  {
    id: 36,
    name: "album-favorite-metadata",
    sql: "ALTER TABLE media_favorites ADD COLUMN metadata_json TEXT;",
  },
  {
    id: 37,
    name: "guided-playlist-mixes",
    sql: `ALTER TABLE smart_playlists ADD COLUMN options_json TEXT;
      ALTER TABLE smart_playlist_tracks ADD COLUMN original_year INTEGER;`,
  },
  {
    id: 38,
    name: "track-content-revisions",
    sql: `ALTER TABLE library_items ADD COLUMN content_revision TEXT NOT NULL DEFAULT '';
      UPDATE library_items SET content_revision = lower(hex(randomblob(16))) WHERE type = 'track';
      ALTER TABLE library_item_sources ADD COLUMN content_fingerprint TEXT;
      ALTER TABLE library_item_sources ADD COLUMN content_metadata_json TEXT;
      ALTER TABLE library_item_sources ADD COLUMN file_fingerprint TEXT;
      ALTER TABLE library_item_sources ADD COLUMN file_path TEXT;
      DELETE FROM track_silence_analysis;
      DELETE FROM track_silence_analysis_profiles;`,
  },
  {
    id: 39,
    name: "upgrade-legacy-smart-playlist-projection",
    sql: (db) => {
      // Early installations applied migration 33 before payloads, normalized
      // genres and activity summaries were added. An applied migration never
      // runs again, so upgrade those databases explicitly without losing mixes.
      db.exec(`CREATE TABLE IF NOT EXISTS smart_playlist_track_payloads (
        track_id TEXT PRIMARY KEY REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
        track_json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS smart_playlist_genres (
        track_id TEXT NOT NULL REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
        genre TEXT NOT NULL, PRIMARY KEY(track_id,genre)
      ) WITHOUT ROWID;`);
      const legacyPayloads = db.prepare("PRAGMA table_info(smart_playlist_tracks)").all()
        .some((column: any) => column.name === "track_json");
      if (legacyPayloads) {
        db.exec(`INSERT INTO smart_playlist_track_payloads(track_id,track_json)
          SELECT id,track_json FROM smart_playlist_tracks WHERE 1
          ON CONFLICT(track_id) DO NOTHING;
          ALTER TABLE smart_playlist_tracks DROP COLUMN track_json;`);
      }

      // Restore exact multi-genre matching from the cached provider payloads.
      // Keep cached tracks usable even while a library source is offline.
      const rows = db.prepare(`SELECT t.id,t.genre,p.track_json FROM smart_playlist_tracks t
        LEFT JOIN smart_playlist_track_payloads p ON p.track_id=t.id`).all() as
        Array<{ id: string; genre: string | null; track_json: string | null }>;
      const insertGenre = db.prepare("INSERT OR IGNORE INTO smart_playlist_genres(track_id,genre) VALUES (?,?)");
      const updateGenres = db.prepare("UPDATE smart_playlist_tracks SET genre=? WHERE id=?");
      for (const row of rows) {
        let genres = row.genre?.split("\u001f") ?? [];
        if (row.track_json) {
          try {
            const payload: unknown = JSON.parse(row.track_json);
            if (payload && typeof payload === "object" && "genres" in payload && Array.isArray(payload.genres)) {
              genres = payload.genres.filter((genre): genre is string => typeof genre === "string");
            }
          } catch { /* Preserve the existing genre when an old cache payload is malformed. */ }
        }
        for (const genre of genres) insertGenre.run(row.id, genre);
        updateGenres.run(genres.length ? genres.join("\u001f") : null, row.id);
      }
      db.exec(`DROP INDEX IF EXISTS smart_tracks_year;
        CREATE INDEX smart_tracks_year ON smart_playlist_tracks(year,genre,id);
        ${smartPlaylistActivitySchema()}`);
    },
  },
  {
    id: 40,
    name: "per-user-durable-scrobble-outbox",
    sql: `
    -- An enabled legacy Last.fm plugin has no shared secret. Disable it before
    -- plugin rehydration so the new required field cannot prevent server startup.
    UPDATE plugin_configs SET enabled=0 WHERE plugin_id='lastfm' AND
      CASE WHEN json_valid(config_json) THEN COALESCE(
        json_type(config_json,'$.apiSecret')='text' AND length(json_extract(config_json,'$.apiSecret'))>0,0)
        ELSE 0 END = 0;
    CREATE TABLE scrobble_connections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('lastfm','listenbrainz')),
      enabled INTEGER NOT NULL DEFAULT 1, credentials_json TEXT NOT NULL,
      username TEXT NOT NULL, account_key TEXT NOT NULL, generation TEXT NOT NULL, connected_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected', last_success_at INTEGER, last_listened_at INTEGER,
      last_error_code TEXT, last_error_message TEXT, last_http_status INTEGER,
      last_checked_at INTEGER, pause_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,provider)
    );
    CREATE TABLE scrobble_queue (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('lastfm','listenbrainz')),
      listening_event_id TEXT NOT NULL REFERENCES listening_events(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL, account_name TEXT NOT NULL, payload_json TEXT NOT NULL,
      listened_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','sending','blocked','failed','sent','ignored','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, delivered_at INTEGER,
      error_code TEXT, error_message TEXT, http_status INTEGER,
      UNIQUE(user_id,provider,dedupe_key), UNIQUE(user_id,provider,listening_event_id)
    );
    CREATE INDEX scrobble_due ON scrobble_queue(state,next_attempt_at,listened_at);
    CREATE INDEX scrobble_stream ON scrobble_queue(user_id,provider,account_name,state,listened_at,created_at,id);
    CREATE TABLE scrobble_auth_states (
      state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );`,
  },
  {
    id: 41,
    name: "playlist-folders-trash-and-reversible-commands",
    sql: `ALTER TABLE playlists ADD COLUMN deleted_at TEXT;
      ALTER TABLE playlists ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX playlists_trash_expiry ON playlists(deleted_at) WHERE deleted_at IS NOT NULL;
      CREATE TABLE playlist_folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
        parent_folder_id TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0),
        UNIQUE(id,user_id),
        FOREIGN KEY(parent_folder_id,user_id) REFERENCES playlist_folders(id,user_id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX playlist_folders_children ON playlist_folders(user_id,parent_folder_id,position,id);
      CREATE TRIGGER playlist_folder_cycle BEFORE UPDATE OF parent_folder_id ON playlist_folders
      WHEN NEW.parent_folder_id IS NOT NULL BEGIN
        SELECT RAISE(ABORT,'Playlist folders cannot contain cycles') WHERE NEW.id IN (
          WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_folder_id UNION
            SELECT f.parent_folder_id FROM playlist_folders f JOIN ancestors a ON f.id=a.id WHERE f.parent_folder_id IS NOT NULL)
          SELECT id FROM ancestors);
      END;
      CREATE TABLE playlist_placements (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        folder_id TEXT, pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0), PRIMARY KEY(user_id,playlist_id),
        FOREIGN KEY(folder_id,user_id) REFERENCES playlist_folders(id,user_id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX playlist_placements_folder ON playlist_placements(user_id,folder_id,position);
      CREATE TABLE playlist_organization_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE playlist_edit_commands (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        label TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
        forward_json TEXT NOT NULL, inverse_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('done','undone')), created_at TEXT NOT NULL
      );
      CREATE INDEX playlist_commands_user ON playlist_edit_commands(user_id,created_at DESC,id);
      CREATE TABLE playlist_provider_tombstones (
        connection_id TEXT NOT NULL, provider_playlist_id TEXT NOT NULL, PRIMARY KEY(connection_id,provider_playlist_id)
      );
      CREATE TRIGGER playlist_trash_tombstone AFTER UPDATE OF deleted_at ON playlists
      WHEN NEW.deleted_at IS NOT NULL AND NEW.source_connection_id IS NOT NULL AND NEW.source_playlist_id IS NOT NULL BEGIN
        INSERT OR IGNORE INTO playlist_provider_tombstones VALUES(NEW.source_connection_id,NEW.source_playlist_id);
      END;
      CREATE TRIGGER playlist_metadata_revision AFTER UPDATE OF name,description,deleted_at ON playlists BEGIN
        UPDATE playlists SET edit_revision=edit_revision+1 WHERE id=NEW.id;
      END;
      CREATE TRIGGER playlist_insert_revision AFTER INSERT ON playlist_items BEGIN
        UPDATE playlists SET edit_revision=edit_revision+1 WHERE id=NEW.playlist_id;
      END;
      CREATE TRIGGER playlist_update_revision AFTER UPDATE ON playlist_items BEGIN
        UPDATE playlists SET edit_revision=edit_revision+1 WHERE id=NEW.playlist_id;
        UPDATE playlists SET edit_revision=edit_revision+1 WHERE id=OLD.playlist_id AND OLD.playlist_id<>NEW.playlist_id;
      END;
      CREATE TRIGGER playlist_remove_revision AFTER DELETE ON playlist_items BEGIN
        UPDATE playlists SET edit_revision=edit_revision+1 WHERE id=OLD.playlist_id;
      END;`,
  },
];

migrations.push({
  id: 42,
  name: "similar-song-mixes-and-discovery-playlist-entries",
  sql: `CREATE TABLE similar_mix_vectors (
    seed_key TEXT PRIMARY KEY, payload_json TEXT, expires_at INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX similar_mix_vectors_expiry ON similar_mix_vectors(touched_at);
  CREATE TABLE similar_mix_external_tracks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, mbid TEXT, preview_url TEXT, preview_checked_at INTEGER,
    touched_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE similar_mix_previews (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    candidate_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL
  );
  CREATE INDEX similar_mix_previews_owner ON similar_mix_previews(user_id,created_at);
  ALTER TABLE playlist_items ADD COLUMN external_track_json TEXT;
  ALTER TABLE smart_playlist_catalog_state ADD COLUMN mix_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recommendation_feedback ADD COLUMN identity_title TEXT;
  ALTER TABLE recommendation_feedback ADD COLUMN identity_artist TEXT;`,
});

migrations.push({ id: 43, name: "private-listening-and-taste-controls", sql: `
  CREATE TABLE taste_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    private_listening INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, reset_before TEXT,
    provider_history_disabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE taste_private_periods(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,ended_at TEXT);
  CREATE INDEX taste_private_periods_owner ON taste_private_periods(user_id,started_at,ended_at);
  CREATE TABLE taste_track_exclusions(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,track_id TEXT NOT NULL,
    recording_key TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,track_id));
  CREATE INDEX taste_track_recording ON taste_track_exclusions(user_id,recording_key);
  ALTER TABLE playlists ADD COLUMN exclude_from_taste INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE listening_events ADD COLUMN taste_excluded INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE listening_events ADD COLUMN context_playlist_id TEXT;
  ALTER TABLE listening_events ADD COLUMN taste_recording_key TEXT;
  ALTER TABLE recently_played ADD COLUMN taste_excluded INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recently_played ADD COLUMN playback_session_id TEXT;
  ALTER TABLE recently_played ADD COLUMN taste_recording_key TEXT;
  ALTER TABLE recommendation_feedback ADD COLUMN identity_album TEXT;
  CREATE VIEW taste_listening_events AS SELECT e.* FROM listening_events e LEFT JOIN taste_settings s ON s.user_id=e.user_id
    WHERE e.taste_excluded=0 AND e.created_at>COALESCE(s.reset_before,'0000') AND NOT EXISTS (
      SELECT 1 FROM taste_track_exclusions x WHERE x.user_id=e.user_id AND (x.track_id=e.track_id OR x.recording_key=e.taste_recording_key));
  CREATE VIEW taste_recently_played AS SELECT e.* FROM recently_played e LEFT JOIN taste_settings s ON s.user_id=e.user_id
    WHERE e.taste_excluded=0 AND e.played_at>COALESCE(s.reset_before,'0000') AND NOT EXISTS (
      SELECT 1 FROM taste_track_exclusions x WHERE x.user_id=e.user_id AND (x.track_id=e.track_id OR x.recording_key=e.taste_recording_key));
  ${(["listening_events", "recently_played"] as const).flatMap(table => ["insert", "update", "delete"].map(op => `DROP TRIGGER IF EXISTS smart_${table}_${op};`)).join("\n")}
  DELETE FROM smart_playlist_activity;
  ${smartPlaylistActivitySchema(true)}
  ${["INSERT", "UPDATE", "DELETE"].map(op => `CREATE TRIGGER taste_feedback_${op.toLowerCase()} AFTER ${op} ON recommendation_feedback BEGIN
    INSERT OR IGNORE INTO taste_settings(user_id) SELECT ${op === "DELETE" ? "OLD" : "NEW"}.user_id WHERE EXISTS(SELECT 1 FROM users WHERE id=${op === "DELETE" ? "OLD" : "NEW"}.user_id);
    UPDATE taste_settings SET revision=revision+1 WHERE user_id=${op === "DELETE" ? "OLD" : "NEW"}.user_id;
  END;`).join("\n")}
` });

migrations.push({ id: 44, name: "explicit-artist-follows-and-new-releases", sql: `
  CREATE TABLE followed_artist_catalog (
    artist_key TEXT PRIMARY KEY, artist_id TEXT NOT NULL, artist_name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('library','deezer','itunes')),
    resolved_id TEXT, next_scan_at INTEGER NOT NULL DEFAULT 0, checked_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE followed_artists (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_key TEXT NOT NULL REFERENCES followed_artist_catalog(artist_key) ON DELETE CASCADE,
    followed_at TEXT NOT NULL, PRIMARY KEY(user_id,artist_key)
  );
  CREATE INDEX followed_artists_catalog ON followed_artists(artist_key);
  CREATE TABLE new_release_cache (
    artist_key TEXT NOT NULL REFERENCES followed_artist_catalog(artist_key) ON DELETE CASCADE,
    release_id TEXT NOT NULL, canonical_key TEXT NOT NULL, release_date TEXT NOT NULL,
    data_json TEXT NOT NULL, cached_at INTEGER NOT NULL, PRIMARY KEY(artist_key,release_id)
  );
  CREATE INDEX new_release_dates ON new_release_cache(release_date DESC,canonical_key);
  CREATE TABLE release_provider_throttle(provider TEXT PRIMARY KEY,next_request_at INTEGER NOT NULL);
` });

migrations.push({ id: 45, name: "playlist-collaboration-and-party-requests", sql: `
  ALTER TABLE playlists ADD COLUMN sharing_mode TEXT NOT NULL DEFAULT 'PRIVATE'
    CHECK(sharing_mode IN ('PRIVATE','SHARED_READ','COLLABORATIVE','PUBLIC_SERVER'));
  ALTER TABLE playlists ADD COLUMN sharing_revision INTEGER NOT NULL DEFAULT 0;
  UPDATE playlists SET sharing_mode='PUBLIC_SERVER' WHERE owner_user_id IS NULL;
  CREATE TABLE playlist_permissions (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('VIEWER','COLLABORATOR')),
    granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, granted_at TEXT NOT NULL,
    PRIMARY KEY(playlist_id,user_id)
  );
  CREATE INDEX playlist_permissions_user ON playlist_permissions(user_id,playlist_id);
  ALTER TABLE playlist_items ADD COLUMN added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  UPDATE playlist_items SET added_by_user_id=(SELECT owner_user_id FROM playlists p WHERE p.id=playlist_items.playlist_id);
  CREATE TABLE playlist_share_links (
    id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    recipient_user_id TEXT REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE INDEX playlist_share_links_playlist ON playlist_share_links(playlist_id,expires_at);
  CREATE TABLE playlist_party_sessions (
    id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    host_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, host_device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER
  );
  CREATE UNIQUE INDEX playlist_party_one_active ON playlist_party_sessions(playlist_id) WHERE closed_at IS NULL;
  CREATE TABLE playlist_party_requests (
    id TEXT PRIMARY KEY, party_id TEXT NOT NULL REFERENCES playlist_party_sessions(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL, requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','QUEUED','DISMISSED')),
    UNIQUE(party_id,requested_by_user_id,idempotency_key)
  );
  CREATE INDEX playlist_party_pending ON playlist_party_requests(party_id,state,created_at);
` });

migrations.push({ id: 46, name: "durable-queue-sessions-and-named-queues", sql: `
  CREATE TABLE queue_contents(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,content_id TEXT NOT NULL,
    compressed BLOB NOT NULL,raw_bytes INTEGER NOT NULL,track_count INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,content_id));
  CREATE TABLE queue_sessions(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT NOT NULL,device_name TEXT NOT NULL,
    content_id TEXT NOT NULL,checkpoint_json TEXT NOT NULL,sequence INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,device_id),FOREIGN KEY(user_id,content_id) REFERENCES queue_contents(user_id,content_id));
  CREATE INDEX queue_sessions_latest ON queue_sessions(user_id,updated_at DESC);
  CREATE TABLE named_queues(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,
    content_id TEXT NOT NULL,checkpoint_json TEXT NOT NULL,operation_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,operation_id),
    FOREIGN KEY(user_id,content_id) REFERENCES queue_contents(user_id,content_id));
  CREATE INDEX named_queues_owner ON named_queues(user_id,updated_at DESC);
  CREATE TABLE queue_playlist_saves(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,
    playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,content_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
` });

migrations.push({ id: 47, name: "sonic-feature-index", sql: `
  CREATE TABLE sonic_vectors (
    track_id TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content_revision TEXT,
    file_revision TEXT NOT NULL,
    vector BLOB NOT NULL CHECK(length(vector) = 512),
    analyzed_at TEXT NOT NULL
  );
  CREATE INDEX sonic_vectors_version_track ON sonic_vectors(version, track_id);
` });

migrations.push({ id: 48, name: "playlist-scoped-audio-scans", sql: `
  ALTER TABLE loudness_scan_jobs ADD COLUMN scope TEXT NOT NULL DEFAULT 'library' CHECK(scope IN ('library','playlists'));
  ALTER TABLE silence_scan_jobs ADD COLUMN scope TEXT NOT NULL DEFAULT 'library' CHECK(scope IN ('library','playlists'));
` });

migrations.push({ id: 49, name: "playlist-pin-order", sql: `
  ALTER TABLE playlist_placements ADD COLUMN pin_position INTEGER;
` });

migrations.push({ id: 50, name: "catalog-and-playlist-query-indexes", sql: `
  CREATE INDEX playlists_owner_deleted_idx ON playlists(owner_user_id, deleted_at);
  CREATE INDEX smart_tracks_artist ON smart_playlist_tracks(artist COLLATE NOCASE, title COLLATE NOCASE, id);
  CREATE INDEX smart_tracks_album ON smart_playlist_tracks(album COLLATE NOCASE, title COLLATE NOCASE, id);
` });

/** A target version lets acceptance tests construct genuine legacy schemas. */
export function runMigrations(db: Database.Database, upTo = Number.POSITIVE_INFINITY) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(db.prepare<[], { id: number }>("SELECT id FROM schema_migrations").all().map(({ id }) => id));
  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?");
  const record = db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
  const apply = db.transaction((migration: Migration) => {
    // Recheck under the write lock in case another process migrated first.
    if (isApplied.get(migration.id)) return;
    if (typeof migration.sql === "function") migration.sql(db);
    else db.exec(migration.sql);
    record.run(migration.id, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (migration.id > upTo) break;
    if (!applied.has(migration.id)) apply.immediate(migration);
  }
}

export async function seedInitialData(db: Database.Database, config: AppConfig) {
  db.prepare(
    "INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)"
  ).run("admin", "Full server administrator");
  db.prepare(
    "INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)"
  ).run("user", "Standard MusicDeck user");

  const now = new Date().toISOString();
  // Seed a connection row for the backend this deployment actually runs.
  // A Jellyfin-only install must not be seeded with an unreachable
  // Navidrome connection that would then be selected as primary.
  const seedType = config.backend;
  const backendCount = db.prepare(
    "SELECT COUNT(*) AS count FROM backend_connections WHERE type = ?"
  ).get(seedType) as { count: number };

  if (backendCount.count === 0) {
    db.prepare(`
      INSERT INTO backend_connections
        (id, type, name, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(
      createId("backend"),
      seedType,
      seedType === "jellyfin" ? "Jellyfin" : "Navidrome",
      JSON.stringify({
        url: seedType === "jellyfin" ? config.jellyfin.url : config.navidrome.url,
        credentials: "environment",
      }),
      now,
      now
    );
  }

  if (config.navidrome.username && config.navidrome.password) {
    const rows = db.prepare(
      "SELECT id, config_json FROM backend_connections WHERE type = ?"
    ).all("navidrome") as Array<{ id: string; config_json: string }>;

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.config_json);

        if (parsed.username || parsed.password) {
          delete parsed.username;
          delete parsed.password;
          parsed.credentials = "environment";

          db.prepare(
            "UPDATE backend_connections SET config_json = ?, updated_at = ? WHERE id = ?"
          ).run(JSON.stringify(parsed), now, row.id);
        }
      } catch {
        // Leave unreadable development config untouched.
      }
    }
  }

  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
    count: number;
  };

  if (userCount.count === 0 && config.firstAdmin.password) {
    const passwordHash = await hashPassword(config.firstAdmin.password);
    db.prepare(`
      INSERT INTO users
        (id, username, password_hash, display_name, role, disabled, is_master, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(
      createId("user"),
      config.firstAdmin.username,
      passwordHash,
      config.firstAdmin.username,
      "admin",
      now,
      now
    );
  }
}

/**
 * Backfill user-data references added in migration 3. Existing
 * favorites/recently_played/playlist_ownership rows are stamped with the
 * placeholder 'env-navidrome' connection by the column defaults; remap them
 * to the current primary enabled backend connection. This runs after seeding
 * so a fresh install's seeded connection exists before the backfill.
 */
export function backfillConnectionScope(db: Database.Database) {
  const hasMigration3 = db.prepare(
    "SELECT id FROM schema_migrations WHERE id = 3"
  ).get();

  if (!hasMigration3) {
    return;
  }

  const primary = db.prepare(
    "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string } | undefined;

  if (!primary) {
    return;
  }

  // favorites/recently_played had their connection_id column dropped by
  // migration 5 (they now store stable MusicDeck IDs). Only backfill the
  // placeholder connection when the column still exists.
  const favoritesHasConnection = db.prepare("PRAGMA table_info(favorites)").all()
    .some((row: any) => row.name === "connection_id");
  const recentHasConnection = db.prepare("PRAGMA table_info(recently_played)").all()
    .some((row: any) => row.name === "connection_id");

  if (favoritesHasConnection) {
    db.prepare(
      "UPDATE favorites SET connection_id = ? WHERE connection_id = 'env-navidrome'"
    ).run(primary.id);
  }

  if (recentHasConnection) {
    db.prepare(
      "UPDATE recently_played SET connection_id = ? WHERE connection_id = 'env-navidrome'"
    ).run(primary.id);
  }

  // playlist_ownership was superseded by the MusicDeck-owned `playlists`
  // table in migration 4; only backfill it when it still exists (i.e. when
  // migrating a pre-8B-4 database that stops at migration 3).
  const hasOwnershipTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlist_ownership'"
  ).get();

  if (hasOwnershipTable) {
    db.prepare(
      "UPDATE playlist_ownership SET connection_id = ? WHERE connection_id = 'env-navidrome'"
    ).run(primary.id);
  }

  // Migration 4 carries playlist_ownership rows into playlists with the
  // placeholder connection before this backfill runs; remap those too.
  const hasPlaylistsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlists'"
  ).get();

  if (hasPlaylistsTable) {
    db.prepare(
      "UPDATE playlists SET source_connection_id = ? WHERE source_connection_id = 'env-navidrome'"
    ).run(primary.id);
  }
}

/**
 * Migration 5 backfill. Creates a stable MusicDeck library identity for every
 * provider-scoped reference that already exists in user data, then rewrites
 * those references from (connection_id, provider_track_id) to the stable
 * MusicDeck track ID.
 *
 * After migration 5, favorites/recently_played.track_id is the MusicDeck ID
 * and the original provider mapping lives in library_item_sources. Rows are
 * never dropped: a mapping is created for every referenced track. The
 * playlist_items.provider_track_id/connection_id columns are retained as the
 * authoritative source mapping for now.
 *
 * Idempotent: an item whose provider reference already maps to a MusicDeck ID
 * is reused, not duplicated.
 */
export function backfillLibraryIdentities(db: Database.Database) {
  // Existing playlists can contain thousands of entries. Commit their identity
  // rewrites together so startup neither fsyncs every row nor leaves half a
  // playlist upgraded when a write fails.
  db.transaction(() => backfillLibraryIdentityRows(db))();
}

function backfillLibraryIdentityRows(db: Database.Database) {
  const hasMigration5 = db.prepare(
    "SELECT id FROM schema_migrations WHERE id = 5"
  ).get();

  if (!hasMigration5) {
    return;
  }

  const primary = db.prepare(
    "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string } | undefined;

  if (!primary) {
    return;
  }

  const now = new Date().toISOString();

  const ensureTrackId = (connectionId: string, providerTrackId: string): string => {
    const existing = db.prepare(`
      SELECT library_item_id AS id FROM library_item_sources
      WHERE connection_id = ? AND provider_item_id = ? AND item_type = 'track'
    `).get(connectionId, providerTrackId) as { id: string } | undefined;

    if (existing) {
      return existing.id;
    }

    const id = createId("md");
    db.prepare(
      "INSERT INTO library_items (id, type, created_at, updated_at) VALUES (?, 'track', ?, ?)"
    ).run(id, now, now);
    db.prepare(`
      INSERT INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
      VALUES (?, 'track', ?, ?, ?)
    `).run(id, connectionId, providerTrackId, now);

    return id;
  };

  // favorites: track_id is currently the provider track ID for the primary
  // connection (connection_id column was dropped in migration 5).
  const favoriteRows = db.prepare(
    "SELECT user_id, track_id, created_at FROM favorites"
  ).all() as Array<{ user_id: string; track_id: string; created_at: string }>;

  for (const row of favoriteRows) {
    if (row.track_id.startsWith("md_")) {
      continue;
    }
    const mdId = ensureTrackId(primary.id, row.track_id);
    db.prepare(
      "UPDATE favorites SET track_id = ? WHERE user_id = ? AND track_id = ?"
    ).run(mdId, row.user_id, row.track_id);
  }

  const recentRows = db.prepare(
    "SELECT id, track_id FROM recently_played"
  ).all() as Array<{ id: string; track_id: string }>;

  for (const row of recentRows) {
    if (row.track_id.startsWith("md_")) {
      continue;
    }
    const mdId = ensureTrackId(primary.id, row.track_id);
    db.prepare(
      "UPDATE recently_played SET track_id = ? WHERE id = ?"
    ).run(mdId, row.id);
  }

  // playlist_items: keep provider mapping, add the stable library_track_id.
  const itemRows = db.prepare(
    "SELECT id, connection_id, provider_track_id FROM playlist_items WHERE library_track_id IS NULL AND external_track_json IS NULL"
  ).all() as Array<{ id: string; connection_id: string; provider_track_id: string }>;

  for (const row of itemRows) {
    const mdId = ensureTrackId(row.connection_id, row.provider_track_id);
    db.prepare(
      "UPDATE playlist_items SET library_track_id = ? WHERE id = ?"
    ).run(mdId, row.id);
  }
}
