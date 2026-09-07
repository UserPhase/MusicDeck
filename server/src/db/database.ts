import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import type { AppConfig } from "../config.js";
import { runMigrations, seedInitialData, backfillConnectionScope, backfillLibraryIdentities } from "./migrations.js";

export type Db = Database.Database;

export async function openDatabase(config: AppConfig) {
  const directory = path.dirname(path.resolve(config.databasePath));
  fs.mkdirSync(directory, { recursive: true });

  const db = new Database(config.databasePath);
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  await seedInitialData(db, config);
  backfillConnectionScope(db);
  backfillLibraryIdentities(db);

  return db;
}
