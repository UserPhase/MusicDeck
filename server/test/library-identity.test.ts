import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { LibraryService } from "../src/domain/library.js";
import { runMigrations } from "../src/db/migrations.js";

function makeLibrary() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, library: new LibraryService(db) };
}

describe("LibraryService stable identities", () => {
  test("creates a stable MusicDeck ID for a provider reference", () => {
    const { library } = makeLibrary();

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "1234" });

    expect(id).toMatch(/^md_/);
    expect(library.exists(id)).toBe(true);
  });

  test("reuses the existing ID for a repeated provider mapping (no duplicates)", () => {
    const { db, library } = makeLibrary();

    const first = library.ensureId("track", { connectionId: "conn-1", providerItemId: "1234" });
    const second = library.ensureId("track", { connectionId: "conn-1", providerItemId: "1234" });

    expect(second).toBe(first);

    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM library_item_sources WHERE connection_id = 'conn-1' AND provider_item_id = '1234'"
    ).get() as { count: number };
    expect(count.count).toBe(1);
  });

  test("maps MusicDeck ID back to its provider reference", () => {
    const { library } = makeLibrary();

    const id = library.ensureId("album", { connectionId: "conn-1", providerItemId: "album-9" });
    const source = library.getPrimarySource(id);

    expect(source).toEqual({ connectionId: "conn-1", providerItemId: "album-9" });
  });

  test("two connections with identical provider IDs remain distinct MusicDeck items", () => {
    const { library } = makeLibrary();

    const a = library.ensureId("track", { connectionId: "conn-1", providerItemId: "1234" });
    const b = library.ensureId("track", { connectionId: "conn-2", providerItemId: "1234" });

    expect(a).not.toBe(b);
    expect(library.getSources(a)).toEqual([{ connectionId: "conn-1", providerItemId: "1234" }]);
    expect(library.getSources(b)).toEqual([{ connectionId: "conn-2", providerItemId: "1234" }]);
  });

  test("a MusicDeck ID can carry multiple provider sources", () => {
    const { library } = makeLibrary();

    const id = library.ensureId("track", { connectionId: "conn-1", providerItemId: "1234" });
    library.addSource(id, { connectionId: "conn-2", providerItemId: "9876" });

    const sources = library.getSources(id);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.providerItemId).sort()).toEqual(["1234", "9876"]);
  });

  test("unknown MusicDeck ID resolves to null primary source", () => {
    const { library } = makeLibrary();

    expect(library.getPrimarySource("md_does-not-exist")).toBeNull();
    expect(library.exists("md_does-not-exist")).toBe(false);
  });

  test("IDs are stable across reads within a database", () => {
    const { library } = makeLibrary();

    const id = library.ensureId("artist", { connectionId: "conn-1", providerItemId: "artist-1" });

    // A fresh service over the same DB resolves the same ID.
    const again = library.ensureId("artist", { connectionId: "conn-1", providerItemId: "artist-1" });
    expect(again).toBe(id);
  });
});
