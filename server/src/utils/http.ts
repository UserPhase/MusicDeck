import type { FastifyReply } from "fastify";

const DEFAULT_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "AUTHENTICATION_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  502: "BACKEND_ERROR",
};

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code = DEFAULT_CODES[statusCode] || "INTERNAL_ERROR"
) {
  return reply.code(statusCode).send({ error: { code, message } });
}
