import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

/** Music backends MusicDeck can run as its primary library provider. */
export type MusicBackendKind = "navidrome" | "jellyfin";

export type AppConfig = {
  host: string;
  port: number;
  publicUrl: string;
  corsOrigin: string;
  sessionSecret: string;
  databasePath: string;
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
  acquisitionTmpDir: string;
};

function readEnv(name: string, fallback = "") {
  return process.env[name] || fallback;
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

  const config: AppConfig = {
    host: readEnv("MUSICDECK_HOST", "127.0.0.1"),
    port: Number(readEnv("MUSICDECK_PORT", "4534")),
    publicUrl: readEnv("MUSICDECK_PUBLIC_URL", "http://localhost:4534"),
    corsOrigin: readEnv("MUSICDECK_CORS_ORIGIN", "http://localhost:3000"),
    sessionSecret: readSecret("MUSICDECK_SESSION_SECRET", "change-this-in-development"),
    databasePath: readDbPath(),
    backend: readBackend(),
    navidrome: {
      url: readEnv("NAVIDROME_URL", "http://192.168.2.38:4533"),
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
