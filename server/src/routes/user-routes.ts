import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import type { User } from "../types.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import { MAX_ARTWORK_REQUEST_BYTES } from "../domain/playlist-artwork.js";
import { clearUserAvatar, getUserAvatar, parseAvatarDataUrl, setUserAvatar } from "../users/avatars.js";
import { createUser, deleteUser, getUserById, listUsers, updateOwnProfile, updateUser } from "../users/users.js";
import { sendError } from "../utils/http.js";

const avatarSchema = z.object({ image: z.string().min(1) }).strict();

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

  /**
   * Upload the caller's avatar as a base64 data URL (same dependency-free
   * contract as playlist artwork). The body limit is raised because base64
   * inflates the 5 MB image cap beyond Fastify's 1 MiB default.
   */
  app.post(
    "/api/users/profile/avatar",
    { bodyLimit: MAX_ARTWORK_REQUEST_BYTES },
    async (request, reply) => {
      const user = requireUser(db, request, reply);

      if (!user) {
        return reply;
      }

      const parsed = avatarSchema.safeParse(request.body);
      const image = parsed.success ? parseAvatarDataUrl(parsed.data.image) : null;

      if (!image) {
        return sendError(reply, 400, "Avatar must be a JPEG, PNG, or WebP image of 5 MB or less", "VALIDATION_ERROR");
      }

      if (!setUserAvatar(db, user.id, image.data, image.contentType)) {
        return sendError(reply, 404, "User not found");
      }

      return { user: getUserById(db, user.id) };
    }
  );

  app.delete("/api/users/profile/avatar", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    clearUserAvatar(db, user.id);
    return { user: getUserById(db, user.id) };
  });

  app.get("/api/users/:userId/avatar", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    const { userId } = request.params as { userId: string };
    const avatar = getUserAvatar(db, userId);

    if (!avatar) {
      return sendError(reply, 404, "Avatar not found");
    }

    // URLs carry a version parameter that changes on every upload.
    reply.header("Content-Type", avatar.contentType);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(avatar.data);
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

    const target = getUserById(db, params.userId);

    if (!target) {
      return sendError(reply, 404, "User not found");
    }

    const guardError = getUpdateGuardError(user, target, parsed.data);

    if (guardError) {
      return sendError(reply, 403, guardError.message, guardError.code);
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
    const target = getUserById(db, params.userId);

    if (!target) {
      return sendError(reply, 404, "User not found");
    }

    if (target.isMasterAdmin) {
      return sendError(reply, 403, "The master administrator cannot be deleted", "MASTER_ADMIN_PROTECTED");
    }

    if (target.id === user.id) {
      return sendError(reply, 403, "You cannot delete your own account", "SELF_LOCKOUT");
    }

    deleteUser(db, params.userId);
    return reply.code(204).send();
  });
}

type UserUpdate = z.infer<typeof updateUserSchema>;

function getUpdateGuardError(actor: User, target: User, update: UserUpdate) {
  if (target.isMasterAdmin) {
    const changesProtectedField =
      (update.role !== undefined && update.role !== target.role)
      || (update.disabled !== undefined && update.disabled !== target.disabled)
      || (update.externalSearchEnabled !== undefined && update.externalSearchEnabled !== target.externalSearchEnabled)
      || (update.externalPlaybackEnabled !== undefined && update.externalPlaybackEnabled !== target.externalPlaybackEnabled);

    if (changesProtectedField) {
      return { message: "The master administrator's role, status, and permissions cannot be changed", code: "MASTER_ADMIN_PROTECTED" };
    }

    if (update.password !== undefined && actor.id !== target.id) {
      return { message: "Only the master administrator can change their own password", code: "MASTER_ADMIN_PROTECTED" };
    }
  }

  if (actor.id === target.id && (update.disabled === true || update.role === "user")) {
    return { message: "You cannot disable or demote your own account", code: "SELF_LOCKOUT" };
  }

  return null;
}
