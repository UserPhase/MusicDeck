import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { getSessionUser } from "./sessions.js";
import { sendError } from "../utils/http.js";

export function requireUser(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply
): SessionUser | null {
  const user = getSessionUser(db, request);

  if (!user) {
    sendError(reply, 401, "Authentication required");
    return null;
  }

  return user;
}

export function requireAdmin(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply
): SessionUser | null {
  const user = requireUser(db, request, reply);

  if (!user) {
    return null;
  }

  if (user.role !== "admin") {
    sendError(reply, 403, "Admin access required");
    return null;
  }

  return user;
}
