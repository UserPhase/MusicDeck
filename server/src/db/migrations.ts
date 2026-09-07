import type Database from "better-sqlite3";

import type { AppConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { createId } from "../utils/ids.js";

const migrations = [
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
];

export function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row: any) => row.id)
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.id, migration.name, new Date().toISOString());
    });

    apply();
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
  const backendCount = db.prepare(
    "SELECT COUNT(*) AS count FROM backend_connections WHERE type = ?"
  ).get("navidrome") as { count: number };

  if (backendCount.count === 0) {
    db.prepare(`
      INSERT INTO backend_connections
        (id, type, name, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(
      createId("backend"),
      "navidrome",
      "Navidrome",
      JSON.stringify({
        url: config.navidrome.url,
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
        (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
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
    "SELECT id, connection_id, provider_track_id FROM playlist_items WHERE library_track_id IS NULL"
  ).all() as Array<{ id: string; connection_id: string; provider_track_id: string }>;

  for (const row of itemRows) {
    const mdId = ensureTrackId(row.connection_id, row.provider_track_id);
    db.prepare(
      "UPDATE playlist_items SET library_track_id = ? WHERE id = ?"
    ).run(mdId, row.id);
  }
}
