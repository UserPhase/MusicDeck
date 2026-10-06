import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { SqliteImportedArtworkRepository, normalizeImportedAlbumName } from "../src/infrastructure/persistence/sqliteImportedArtworkRepository.js";

const cover = "https://i.scdn.co/image/cover1";
test("matches punctuation, apostrophes, case and diacritics through an indexed normalized key", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    runMigrations(db);
    const repo = new SqliteImportedArtworkRepository(db);
    repo.save("Dóminic Fike", "Don't Forget About Me, Demos", cover, "spotifyalbum");
    expect(normalizeImportedAlbumName("Don't Forget About Me, Demos")).toBe("dont forget about me demos");
    expect(repo.find("DOMINIC FIKE", "Dont forget about me demos")).toBe(cover);
    expect(repo.find("Dominic Fike", "Don’t Forget About Me, Demos")).toBe(cover);
    expect(repo.find("Other Artist", "Don't Forget About Me, Demos")).toBeNull();
    expect(repo.find("Dominic Fike", "Don't Forget About Me, Demos (Deluxe)")).toBeNull();
    repo.save("Dominic Fike", "Don't Forget About Me, Demos", "https://i.scdn.co/image/cover2");
    expect(repo.find("Dominic Fike", "Don't Forget About Me, Demos")).toBe("https://i.scdn.co/image/cover2");
    expect(db.prepare("SELECT spotify_album_id FROM imported_album_artwork").get()).toEqual({ spotify_album_id: "spotifyalbum" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM imported_album_artwork").get()).toEqual({ count: 1 });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT cover_url FROM imported_album_artwork WHERE artist_name = ? AND album_name = ?")
      .all("dominic fike", "demos") as Array<{ detail: string }>;
    expect(plan[0].detail).toContain("USING INDEX");
  } finally { db.close(); }
});

test("rejects invalid or unsafe cached metadata and parameterizes all names", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    const repo = new SqliteImportedArtworkRepository(db);
    expect(() => repo.save("", "Album", cover)).toThrow("Invalid");
    expect(() => repo.save("Artist", "Album", "http://localhost/private")).toThrow("Invalid");
    expect(() => repo.save("Artist", "Album", "https://user:secret@i.scdn.co/image/abc")).toThrow("Invalid");
    repo.save("'; DROP TABLE imported_album_artwork; --", "Album", cover);
    expect(repo.find("'; DROP TABLE imported_album_artwork; --", "Album")).toBe(cover);
    db.prepare("UPDATE imported_album_artwork SET cover_url = ?").run("http://localhost/private");
    expect(() => repo.find("'; DROP TABLE imported_album_artwork; --", "Album")).toThrow("Stored");
  } finally { db.close(); }
});
