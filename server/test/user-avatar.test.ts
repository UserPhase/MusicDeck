import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("avatar-bytes"),
]);

function dataUrl(type: string, bytes: Buffer) {
  return `data:${type};base64,${bytes.toString("base64")}`;
}

describe("user avatar uploads", () => {
  test("uploads, serves, exposes in the session, and removes an avatar", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/users/profile/avatar",
      headers: { cookie },
      payload: { image: dataUrl("image/png", PNG) },
    });

    expect(uploaded.statusCode).toBe(200);
    const user = uploaded.json().user;
    expect(user.avatarUrl).toMatch(new RegExp(`^/api/users/${user.id}/avatar\\?v=`));

    const session = await app.inject({ method: "GET", url: "/api/users/me", headers: { cookie } });
    expect(session.json().user.avatarUrl).toBe(user.avatarUrl);

    const image = await app.inject({ method: "GET", url: user.avatarUrl, headers: { cookie } });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.rawPayload.equals(PNG)).toBe(true);

    const anonymous = await app.inject({ method: "GET", url: user.avatarUrl });
    expect(anonymous.statusCode).toBe(401);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/users/profile/avatar",
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().user.avatarUrl).toBeNull();

    const gone = await app.inject({ method: "GET", url: user.avatarUrl, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });

  test("a re-upload changes the avatar URL so caches are busted", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const first = await app.inject({
      method: "POST", url: "/api/users/profile/avatar", headers: { cookie },
      payload: { image: dataUrl("image/png", PNG) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.inject({
      method: "POST", url: "/api/users/profile/avatar", headers: { cookie },
      payload: { image: dataUrl("image/png", PNG) },
    });

    expect(second.json().user.avatarUrl).not.toBe(first.json().user.avatarUrl);
  });

  test("rejects unsupported, mislabeled, and oversized images", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const payloads = [
      dataUrl("image/gif", Buffer.from("GIF89a-avatar")),
      dataUrl("image/svg+xml", Buffer.from("<svg onload=alert(1)>")),
      dataUrl("image/png", Buffer.from("<html>not a png</html>")),
      dataUrl("image/png", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])),
    ];

    for (const image of payloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/users/profile/avatar",
        headers: { cookie },
        payload: { image },
      });

      expect(response.statusCode).toBe(400);
    }

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/users/profile/avatar",
      payload: { image: dataUrl("image/png", PNG) },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  test("users only change their own avatar", async () => {
    current = await createTestServer();
    const { app, db } = current;
    await createUser(db, { username: "listener", password: "listener-password", role: "user" });

    const admin = await login(app);
    const listener = await login(app, "listener", "listener-password");

    await app.inject({
      method: "POST", url: "/api/users/profile/avatar", headers: { cookie: listener.cookie },
      payload: { image: dataUrl("image/png", PNG) },
    });

    const me = await app.inject({ method: "GET", url: "/api/users/me", headers: { cookie: admin.cookie } });
    expect(me.json().user.avatarUrl).toBeNull();
  });
});
