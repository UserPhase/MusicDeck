/**
 * Normalized plugin/provider failure states. Every plugin or provider test,
 * enable, or connection failure should be classified into one of these
 * states instead of surfacing a raw error (which may leak stack traces or
 * provider-specific details) or a generic 500.
 */
export const PLUGIN_ERROR_STATUSES = [
  "success",
  "not_configured",
  "authentication_failed",
  "provider_unavailable",
  "timeout",
  "permission_denied",
  "plugin_error",
] as const;

export type PluginErrorStatus = (typeof PLUGIN_ERROR_STATUSES)[number];

export type PluginErrorClassification = {
  status: PluginErrorStatus;
  message: string;
};

const DEFAULT_MESSAGES: Record<Exclude<PluginErrorStatus, "success">, string> = {
  not_configured: "Plugin is not fully configured",
  authentication_failed: "Authentication failed",
  provider_unavailable: "Provider is unavailable",
  timeout: "Connection timed out",
  permission_denied: "Plugin is missing an approved permission",
  plugin_error: "Plugin reported an unexpected error",
};

/** Marks a thrown error as already having a known, safe-to-display status. */
export class ClassifiedPluginError extends Error {
  constructor(readonly status: PluginErrorStatus, message?: string) {
    super(message || DEFAULT_MESSAGES[status as Exclude<PluginErrorStatus, "success">] || "Plugin error");
    this.name = "ClassifiedPluginError";
  }
}

export class PluginTimeoutError extends Error {
  constructor(message = "Plugin request timed out") {
    super(message);
    this.name = "PluginTimeoutError";
  }
}

/**
 * Classifies an unknown thrown value into a normalized, client-safe status
 * and message. Never includes stack traces, credentials, or raw upstream
 * response bodies; callers should log the original error separately.
 */
export function classifyPluginError(error: unknown): PluginErrorClassification {
  if (error instanceof ClassifiedPluginError) {
    return { status: error.status, message: error.message };
  }

  if (error instanceof PluginTimeoutError || (error instanceof Error && error.name === "AbortError")) {
    return { status: "timeout", message: DEFAULT_MESSAGES.timeout };
  }

  const message = error instanceof Error ? error.message : String(error ?? "");

  if (/misconfigured|not configured|missing.*(config|field)/i.test(message)) {
    return { status: "not_configured", message: DEFAULT_MESSAGES.not_configured };
  }
  if (/permission/i.test(message)) {
    return { status: "permission_denied", message: DEFAULT_MESSAGES.permission_denied };
  }
  if (/authentication|unauthorized|forbidden|invalid.*(token|credential|key)|401|403/i.test(message)) {
    return { status: "authentication_failed", message: DEFAULT_MESSAGES.authentication_failed };
  }
  if (/timed? ?out|timeout|abort/i.test(message)) {
    return { status: "timeout", message: DEFAULT_MESSAGES.timeout };
  }
  if (/unavailable|unreachable|network|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { status: "provider_unavailable", message: DEFAULT_MESSAGES.provider_unavailable };
  }

  return { status: "plugin_error", message: DEFAULT_MESSAGES.plugin_error };
}

/** Wraps a fetch implementation so plugin/provider network calls that hang
 * are classified as timeouts instead of crashing the request indefinitely. */
export function withPluginTimeout(fetchImpl: typeof fetch, timeoutMs = 10_000): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: init?.signal || controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PluginTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/** Maps a normalized status to an appropriate HTTP status code for admin API responses. */
export function httpStatusForPluginError(status: PluginErrorStatus): number {
  switch (status) {
    case "not_configured":
      return 400;
    case "permission_denied":
      return 403;
    case "authentication_failed":
      return 401;
    case "timeout":
    case "provider_unavailable":
      return 502;
    case "plugin_error":
      return 500;
    default:
      return 200;
  }
}
