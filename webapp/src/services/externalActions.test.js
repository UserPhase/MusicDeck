import { acquisitionPayload, createExternalActions, stateForJobStatus } from "./externalActions";

const album = {
  id: "external_deezer_album_1",
  title: "Chart Album",
  artist: "Chart Artist",
  provider: "deezer",
  source: { kind: "external", count: 0 },
  metadata: { songCount: 10, recommendationReason: "dropped", coverUrl: "dropped" },
};

function harness(overrides = {}) {
  const timers = [];
  const deps = {
    create: jest.fn(),
    get: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    isOnline: jest.fn(() => true),
    schedule: jest.fn((callback, delay) => {
      const handle = { callback, delay };
      timers.push(handle);
      return handle;
    }),
    cancel: jest.fn((handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    }),
    ...overrides,
  };
  const actions = createExternalActions(deps);
  const flushTimer = async () => {
    const handle = timers.shift();
    if (!handle) throw new Error("No poll scheduled");
    handle.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return handle;
  };
  return { actions, deps, timers, flushTimer, key: `album:${album.id}` };
}

test("maps every server job status onto the card lifecycle", () => {
  expect(stateForJobStatus("queued")).toBe("QUEUED");
  for (const status of ["discovering", "downloading", "processing", "importing"]) expect(stateForJobStatus(status)).toBe("IMPORTING");
  expect(stateForJobStatus("completed")).toBe("IN_LIBRARY");
  expect(stateForJobStatus("failed")).toBe("FAILED");
  expect(stateForJobStatus("cancelled")).toBe("IDLE");
});

test("builds a payload the strict server schema accepts", () => {
  expect(acquisitionPayload("album", album)).toEqual({
    result: {
      id: album.id,
      type: "album",
      title: "Chart Album",
      artist: "Chart Artist",
      provider: "deezer",
      source: { kind: "external", count: 0 },
      metadata: { songCount: 10 },
    },
    albumId: album.id,
    sourceProvider: "spotdl",
  });
  expect(acquisitionPayload("track", { id: "t", name: "Song", provider: "unknown" })).toMatchObject({
    result: { type: "track", title: "Song", album: "", provider: "external" },
    trackId: "t",
  });
});

test("walks IDLE → QUEUED → IMPORTING → IN_LIBRARY and stops polling", async () => {
  const { actions, deps, timers, flushTimer, key } = harness();
  deps.create.mockResolvedValue({ jobId: "job-1", status: "queued", job: { id: "job-1", status: "queued" } });
  const listener = jest.fn();
  actions.subscribe(key, listener);

  expect(actions.getSnapshot(key).state).toBe("IDLE");
  const pending = actions.saveExternalAlbum(album);
  expect(actions.getSnapshot(key).state).toBe("QUEUED");
  await expect(pending).resolves.toMatchObject({ state: "QUEUED", jobId: "job-1" });
  expect(timers).toHaveLength(1);

  deps.get.mockResolvedValueOnce({ id: "job-1", status: "downloading", progress: { percent: 41.6 } });
  await flushTimer();
  expect(actions.getSnapshot(key)).toMatchObject({ state: "IMPORTING", progress: 42, message: "Importing Chart Album… 42%" });

  deps.get.mockResolvedValueOnce({ id: "job-1", status: "completed" });
  await flushTimer();
  expect(actions.getSnapshot(key)).toMatchObject({ state: "IN_LIBRARY", message: "Chart Album is in your library." });
  expect(timers).toHaveLength(0);
  expect(listener).toHaveBeenCalled();
});

test("rapid repeat clicks create exactly one import job", async () => {
  const { actions, deps, key } = harness();
  let resolve;
  deps.create.mockImplementation(() => new Promise((done) => { resolve = done; }));

  const first = actions.saveExternalAlbum(album);
  const second = actions.saveExternalAlbum(album);
  await Promise.resolve();
  resolve({ job: { id: "job-1", status: "queued" } });
  await Promise.all([first, second]);
  await actions.saveExternalAlbum(album);

  expect(deps.create).toHaveBeenCalledTimes(1);
  expect(actions.getSnapshot(key).jobId).toBe("job-1");
});

test("an item already in the library resolves straight to IN_LIBRARY", async () => {
  const { actions, deps, timers, key } = harness();
  deps.create.mockResolvedValue({ jobId: "job-1", status: "completed", job: { id: "job-1", status: "completed" } });
  await actions.saveExternalAlbum(album);
  expect(actions.getSnapshot(key).state).toBe("IN_LIBRARY");
  expect(timers).toHaveLength(0);
});

test("start failures become clear FAILED messages instead of rejections", async () => {
  const { actions, deps, key } = harness();
  deps.create.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(actions.saveExternalAlbum(album)).resolves.toMatchObject({ state: "FAILED" });
  expect(actions.getSnapshot(key).message).toBe("Can't reach MusicDeck. Check your connection and try again.");

  deps.create.mockRejectedValueOnce(new Error("On-demand acquisitions are not enabled for this user"));
  await actions.saveExternalAlbum(album);
  expect(actions.getSnapshot(key).message).toBe("Couldn't start the import: On-demand acquisitions are not enabled for this user");

  deps.isOnline.mockReturnValue(false);
  await actions.saveExternalAlbum(album);
  expect(actions.getSnapshot(key).message).toBe("You're offline. Reconnect, then try again.");
  expect(deps.create).toHaveBeenCalledTimes(2);
});

test("a server-side failure shows the job's error and allows retry", async () => {
  const { actions, deps, flushTimer, key } = harness();
  deps.create.mockResolvedValue({ job: { id: "job-1", status: "queued" } });
  await actions.saveExternalAlbum(album);
  deps.get.mockResolvedValueOnce({ id: "job-1", status: "failed", errorMessage: "No matching release found" });
  await flushTimer();
  expect(actions.getSnapshot(key)).toMatchObject({ state: "FAILED", message: "Import failed: No matching release found" });

  deps.create.mockResolvedValue({ job: { id: "job-2", status: "queued" } });
  await actions.saveExternalAlbum(album);
  expect(actions.getSnapshot(key)).toMatchObject({ state: "QUEUED", jobId: "job-2" });
});

test("a network drop while importing keeps the job, backs off, then asks for a safe retry", async () => {
  const { actions, deps, flushTimer, timers, key } = harness();
  deps.create.mockResolvedValue({ job: { id: "job-1", status: "downloading" } });
  await actions.saveExternalAlbum(album);
  deps.get.mockRejectedValue(new TypeError("Failed to fetch"));

  const first = await flushTimer();
  expect(actions.getSnapshot(key)).toMatchObject({ state: "IMPORTING", connectionLost: true, jobId: "job-1" });
  expect(actions.getSnapshot(key).message).toMatch(/import continues on the server/);
  expect(timers[0].delay).toBeGreaterThan(first.delay);

  for (let attempt = 0; attempt < 5; attempt += 1) await flushTimer();
  expect(actions.getSnapshot(key)).toMatchObject({ state: "FAILED", connectionLost: true });
  expect(actions.getSnapshot(key).message).toMatch(/won't start a duplicate/);
  expect(timers).toHaveLength(0);

  // The server reuses the unfinished job, so Retry rejoins it.
  deps.create.mockResolvedValue({ job: { id: "job-1", status: "importing" } });
  deps.get.mockResolvedValue({ id: "job-1", status: "completed" });
  await actions.saveExternalAlbum(album);
  await flushTimer();
  expect(actions.getSnapshot(key).state).toBe("IN_LIBRARY");
});

test("hydrates in-flight and completed imports from the server once", async () => {
  const { actions, deps, timers } = harness();
  deps.list.mockResolvedValue([
    { id: "job-3", status: "importing", requestedAlbumId: "a1" },
    { id: "job-2", status: "completed", requestedTrackId: "t1", requestedAlbumId: "a2" },
    { id: "job-1", status: "failed", requestedAlbumId: "a1" },
    { id: "job-0", status: "cancelled", requestedAlbumId: "a3" },
  ]);
  await actions.hydrate();
  await actions.hydrate();

  expect(deps.list).toHaveBeenCalledTimes(1);
  expect(actions.getSnapshot("album:a1")).toMatchObject({ state: "IMPORTING", jobId: "job-3" });
  expect(actions.getSnapshot("track:t1").state).toBe("IN_LIBRARY");
  expect(actions.getSnapshot("album:a3").state).toBe("IDLE");
  expect(timers).toHaveLength(1);
});

test("a failed hydration is retried by the next caller", async () => {
  const { actions, deps } = harness();
  deps.list.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce([]);
  await expect(actions.hydrate()).resolves.toBeUndefined();
  await actions.hydrate();
  expect(deps.list).toHaveBeenCalledTimes(2);
});
