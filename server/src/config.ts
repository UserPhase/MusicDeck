import dotenv from "dotenv";
import fs from "node:fs";
import { isIP } from "node:net";
import { DEFAULT_LOGIN_RATE_LIMIT, type LoginRateLimitConfig } from "./auth/login-rate-limiter.js";
import { DEFAULT_ACQUISITION_LIMITS, type AcquisitionLimits } from "./domain/acquisition-limits.js";

dotenv.config();

/** Music backends MusicDeck can run as its primary library provider. */
export type MusicBackendKind = "navidrome" | "jellyfin";

export type AppConfig = {
  localOnlyMode: boolean;
  trustedProxies: string[];
  loginRateLimit: LoginRateLimitConfig;
  acquisitionLimits: AcquisitionLimits;
  host: string;
  port: number;
  publicUrl: string;
  corsOrigin: string;
  sessionSecret: string;
  databasePath: string;
  extensionsDir: string;
  backend: MusicBackendKind;
  navidrome: {
    url: string;
    username: string;
    password: string;
  };
  jellyfin: {
    url: string;
    apiKey: string;
  };
  firstAdmin: {
    username: string;
    password: string;
  };
  isProduction: boolean;
    secureCookies: boolean;
  musicRoot: string;
  spotifyImportSubdir: string;
  acquisitionTmpDir: string;
};

function readEnv(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number(readEnv(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readTrustedProxies() {
  const value = readEnv("MUSICDECK_TRUSTED_PROXIES").trim();
  if (!value) return [];
  return value.split(",").map((entry) => {
    const proxy = entry.trim();
    const [address, prefix, extra] = proxy.split("/");
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && (
      !/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > (version === 4 ? 32 : 128)
    ))) {
      throw new Error("MUSICDECK_TRUSTED_PROXIES must contain only explicit IP addresses or CIDRs");
    }
    if (prefix !== undefined && Number(prefix) === 0) {
      throw new Error("MUSICDECK_TRUSTED_PROXIES must not trust all network addresses");
    }
    return proxy;
  });
}

function readSecret(name: string, fallback = "") {
  const filePath = process.env[`${name}_FILE`];

  if (filePath) {
    return fs.readFileSync(filePath, "utf8").trim();
  }

  return readEnv(name, fallback);
}

function readDbPath() {
  return readEnv(
    "MUSICDECK_DB_PATH",
    readEnv("MUSICDECK_DATABASE_PATH", "./data/musicdeck.sqlite")
  );
}

function readSecureCookies(isProduction: boolean) {
  const override = readEnv("MUSICDECK_SECURE_COOKIES", "");

  if (override === "true") return true;
  if (override === "false") return false;

  return isProduction;
}

export function validateConfig(config: AppConfig) {
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("MUSICDECK_PORT must be a valid TCP port");
  }

  if (!config.host) {
    throw new Error("MUSICDECK_HOST is required");
  }

  if (!config.databasePath) {
    throw new Error("MUSICDECK_DB_PATH is required");
  }

  if (!config.sessionSecret || config.sessionSecret === "change-this-in-development") {
    throw new Error("MUSICDECK_SESSION_SECRET must be set to a non-default value");
  }

  // Only the selected backend's connection settings are required. A
  // Jellyfin-only deployment must not be forced to invent Navidrome
  // credentials (and vice versa) just to pass startup validation.
  if (config.backend === "jellyfin") {
    try {
      new URL(config.jellyfin.url);
    } catch {
      throw new Error("JELLYFIN_URL must be a valid URL");
    }

    if (!config.jellyfin.apiKey) {
      throw new Error("JELLYFIN_API_KEY is required when MUSIC_BACKEND=jellyfin");
    }

    return;
  }

  try {
    new URL(config.navidrome.url);
  } catch {
    throw new Error("NAVIDROME_URL must be a valid URL");
  }

  if (!config.navidrome.username) {
    throw new Error("NAVIDROME_USERNAME is required");
  }

  if (!config.navidrome.password) {
    throw new Error("NAVIDROME_PASSWORD is required");
  }
}

/**
 * Read the primary backend selection. Production Compose sets this to run
 * exactly one backend; anything unrecognized fails loudly rather than
 * silently falling back to a backend the operator did not deploy.
 */
function readBackend(): MusicBackendKind {
  const value = readEnv("MUSIC_BACKEND", "navidrome").trim().toLowerCase();

  if (value === "navidrome" || value === "jellyfin") {
    return value;
  }

  throw new Error(`MUSIC_BACKEND must be "navidrome" or "jellyfin" (received "${value}")`);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const localOnlyValue = readEnv("LOCAL_ONLY_MODE", "false").toLowerCase();
  if (!["true", "false", "1", "0"].includes(localOnlyValue)) throw new Error("LOCAL_ONLY_MODE must be true, false, 1 or 0");

  const config: AppConfig = {
    localOnlyMode: ["true", "1"].includes(localOnlyValue),
    trustedProxies: readTrustedProxies(),
    acquisitionLimits: Object.fromEntries(Object.entries(DEFAULT_ACQUISITION_LIMITS).map(([key, fallback]) => [
      key, readPositiveInteger(`MUSICDECK_ACQUISITION_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`, fallback),
    ])) as AcquisitionLimits,
    loginRateLimit: {
      windowMs: readPositiveInteger("MUSICDECK_LOGIN_WINDOW_MS", DEFAULT_LOGIN_RATE_LIMIT.windowMs),
      ipMax: readPositiveInteger("MUSICDECK_LOGIN_IP_MAX", DEFAULT_LOGIN_RATE_LIMIT.ipMax),
      accountMax: readPositiveInteger("MUSICDECK_LOGIN_ACCOUNT_MAX", DEFAULT_LOGIN_RATE_LIMIT.accountMax),
      maxConcurrent: readPositiveInteger("MUSICDECK_LOGIN_MAX_CONCURRENT", DEFAULT_LOGIN_RATE_LIMIT.maxConcurrent),
      maxEntries: readPositiveInteger("MUSICDECK_LOGIN_MAX_ENTRIES", DEFAULT_LOGIN_RATE_LIMIT.maxEntries),
    },
    host: readEnv("MUSICDECK_HOST", "127.0.0.1"),
    port: Number(readEnv("MUSICDECK_PORT", "4534")),
    publicUrl: readEnv("MUSICDECK_PUBLIC_URL", "http://localhost:4534"),
    corsOrigin: readEnv("MUSICDECK_CORS_ORIGIN", "http://localhost:3000"),
    sessionSecret: readSecret("MUSICDECK_SESSION_SECRET", "change-this-in-development"),
    databasePath: readDbPath(),
    extensionsDir: readEnv("MUSICDECK_EXTENSIONS_DIR", "./extensions"),
    backend: readBackend(),
    navidrome: {
      url: readEnv("NAVIDROME_URL", "http://localhost:4533"),
      username: readEnv("NAVIDROME_USERNAME"),
      password: readSecret("NAVIDROME_PASSWORD"),
    },
    jellyfin: {
      url: readEnv("JELLYFIN_URL", "http://jellyfin:8096"),
      apiKey: readSecret("JELLYFIN_API_KEY"),
    },
    firstAdmin: {
      username: readEnv("MUSICDECK_ADMIN_USERNAME", "admin"),
      password: readEnv("MUSICDECK_ADMIN_PASSWORD"),
    },
    isProduction,
    secureCookies: readSecureCookies(isProduction),
    // Where downloaded/acquired music files are written before Navidrome
    // scans them. This MUST point at the same folder Navidrome's own music
    // library is configured to read from (e.g. a shared/mounted path, or the
    // same volume in Docker Compose) — otherwise files downloaded by
    // MusicDeck's acquisition pipeline will never be visible to Navidrome or
    // playable in the library, even though the download itself succeeded.
    musicRoot: readEnv("MUSICDECK_MUSIC_ROOT", "./data/music"),
    spotifyImportSubdir: readEnv("MUSICDECK_SPOTIFY_IMPORT_SUBDIR", "Spotify Imports"),
    acquisitionTmpDir: readEnv("MUSICDECK_ACQUISITION_TMP_DIR", "./data/acquisitions/tmp"),
  };

  return {
    ...config,
    ...overrides,
    navidrome: {
      ...config.navidrome,
      ...overrides.navidrome,
    },
    jellyfin: {
      ...config.jellyfin,
      ...overrides.jellyfin,
    },
    firstAdmin: {
      ...config.firstAdmin,
      ...overrides.firstAdmin,
    },
  };
}
