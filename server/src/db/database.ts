import Database from "better-sqlite3";

import type { AppConfig } from "../config.js";
import { runMigrations, seedInitialData, backfillConnectionScope, backfillLibraryIdentities } from "./migrations.js";
import { prepareDatabasePath, protectDatabaseFiles } from "./file-permissions.js";

export type Db = Database.Database;

export async function openDatabase(config: AppConfig) {
  const persistent = config.databasePath !== ":memory:" && config.databasePath !== "";
  if (persistent) prepareDatabasePath(config.databasePath);

  const db = new Database(config.databasePath, { timeout: 5_000 });
  try {
    db.pragma("foreign_keys = ON");
    if (persistent) {
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      if (mode !== "wal") throw new Error(`Could not enable SQLite WAL mode (current mode: ${String(mode)}). Use a writable local volume for MUSICDECK_DB_PATH.`);
      // Keep the commit durability of the previous rollback-journal default.
      db.pragma("synchronous = FULL");
    }

    runMigrations(db);
    await seedInitialData(db, config);
    backfillConnectionScope(db);
    backfillLibraryIdentities(db);
    if (persistent) protectDatabaseFiles(config.databasePath);

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
