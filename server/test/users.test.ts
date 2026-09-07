import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup() {
  current = await createTestServer();
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("users and roles", () => {
  test("normal users cannot access admin user endpoints", async () => {
    const { app } = await setup();
    const admin = await login(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie },
      payload: {
        username: "listener",
        password: "listener-password",
        role: "user",
      },
    });

    expect(create.statusCode).toBe(201);

    const normal = await login(app, "listener", "listener-password");
    const denied = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: normal.cookie },
    });

    expect(denied.statusCode).toBe(403);
  });

  test("admin users can create, update, list, and delete users", async () => {
    const { app } = await setup();
    const admin = await login(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie },
      payload: {
        username: "listener",
        password: "listener-password",
        displayName: "Listener",
        role: "user",
      },
    });

    expect(create.statusCode).toBe(201);
    const userId = create.json().user.id;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/users/${userId}`,
      headers: { cookie: admin.cookie },
      payload: { displayName: "Updated Listener", role: "admin" },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().user).toMatchObject({
      displayName: "Updated Listener",
      role: "admin",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: admin.cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().users.length).toBeGreaterThanOrEqual(2);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/users/${userId}`,
      headers: { cookie: admin.cookie },
    });

    expect(remove.statusCode).toBe(204);
  });
});
