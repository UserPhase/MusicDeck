import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import { createUser, deleteUser, getUserById, listUsers, updateOwnProfile, updateUser } from "../users/users.js";
import { sendError } from "../utils/http.js";

const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "user"]).optional(),
});

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  avatarRef: z.string().min(1).nullable().optional(),
  role: z.enum(["admin", "user"]).optional(),
  disabled: z.boolean().optional(),
  externalSearchEnabled: z.boolean().optional(),
  externalPlaybackEnabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

const updateMeSchema = z.object({
  displayName: z.string().min(1).optional(),
  avatarRef: z.string().min(1).nullable().optional(),
}).strict();

export async function registerUserRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/users/me", async (request, reply) => {
    const user = requireUser(db, request, reply);
    return user ? { user } : reply;
  });

  app.patch("/api/users/me", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = updateMeSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid profile update request", "VALIDATION_ERROR");
    }

    return { user: await updateOwnProfile(db, user.id, parsed.data) };
  });

  app.get("/api/users", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    return user ? { users: listUsers(db) } : reply;
  });

  app.post("/api/users", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = createUserSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid user request");
    }

    try {
      const created = await createUser(db, parsed.data);
      return reply.code(201).send({ user: created });
    } catch {
      return sendError(reply, 409, "User could not be created");
    }
  });

  app.patch("/api/users/:userId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const params = request.params as { userId: string };
    const parsed = updateUserSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid user update request");
    }

    const updated = await updateUser(db, params.userId, parsed.data);

    if (!updated) {
      return sendError(reply, 404, "User not found");
    }

    return { user: updated };
  });

  app.delete("/api/users/:userId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const params = request.params as { userId: string };

    if (!getUserById(db, params.userId)) {
      return sendError(reply, 404, "User not found");
    }

    deleteUser(db, params.userId);
    return reply.code(204).send();
  });
}
