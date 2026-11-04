import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { recordPlayback, scrobblePointSeconds, type PlaybackEvent } from "../src/domain/listening-activity.js";

let current: Awaited<ReturnType<typeof createTestServer>>;
let userId: string;
const now = Date.parse("2026-10-08T12:00:00Z");
const event = (seconds: number, durationSeconds: number | null = 180, id = "scrobble-0001"): PlaybackEvent => ({
  playbackSessionId: id, trackId: "track-1", startedAt: new Date(now - 600_000).toISOString(),
  listenedSeconds: seconds, durationSeconds, finished: false,
  track: { title: "Night Music", artist: "Test Artist", album: "First Album" },
});

beforeAll(async () => {
  current = await createTestServer();
  const admin = await login(current.app);
  if (!admin.cookie) throw new Error("Admin login failed");
  userId = (current.db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
});
beforeEach(() => {
  current.db.exec("DELETE FROM listening_events; DELETE FROM recently_played");
});
afterAll(async () => { await closeTestServer(current.app, current.db); });

describe("scrobble point", () => {
  test("is 50% of the track or 20 seconds, whichever comes first", () => {
    expect(scrobblePointSeconds(180)).toBe(20);
    expect(scrobblePointSeconds(30)).toBe(15);
    expect(scrobblePointSeconds(null)).toBe(20);
    expect(scrobblePointSeconds(0)).toBe(20);
  });

  test("is due exactly once when cumulative listening crosses it, independent of the counted threshold", () => {
    expect(recordPlayback(current.db, userId, event(19.5), now).scrobbleDue).toBe(false);
    const crossed = recordPlayback(current.db, userId, event(20), now);
    expect(crossed.scrobbleDue).toBe(true);
    expect(crossed.counted).toBe(false);
    expect(recordPlayback(current.db, userId, event(20), now).scrobbleDue).toBe(false);
    expect(recordPlayback(current.db, userId, event(31), now).scrobbleDue).toBe(false);
  });

  test("short tracks scrobble at half their duration and a late report cannot repeat it", () => {
    expect(recordPlayback(current.db, userId, event(14, 30), now).scrobbleDue).toBe(false);
    expect(recordPlayback(current.db, userId, event(15, 30), now).scrobbleDue).toBe(true);
    expect(recordPlayback(current.db, userId, event(12, 30), now).scrobbleDue).toBe(false);
  });
});
