import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_ACQUISITION_LIMITS } from "../src/domain/acquisition-limits.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const standalone = process.env.MUSICDECK_TEST_COMPOSE_BINARY;
const command = standalone || "docker";
const prefix = standalone ? [] : ["compose"];
const probe = spawnSync(command, [...prefix, "version"], { encoding: "utf8" });
const available = !probe.error && probe.status === 0;
if (standalone && !available) throw new Error("MUSICDECK_TEST_COMPOSE_BINARY is not a working Compose executable");
let directory: string | undefined;

type ComposeService = {
  ports?: Array<{ host_ip?: string; published: string; target: number }>;
  environment?: Record<string, string>;
  networks?: Record<string, unknown>;
  profiles?: string[];
  expose?: string[];
  healthcheck?: { test: string[] };
};
type ComposeConfig = { services: Record<string, ComposeService> };

function render(file: string, overrides: Record<string, string> = {}, profiles = ["navidrome", "jellyfin"], fromTemplate = false): ComposeConfig {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-compose-security-"));
  const envFile = path.join(directory, ".env");
  let contents = fromTemplate ? fs.readFileSync(path.join(root, ".env.example"), "utf8") : "";
  for (const [key, value] of Object.entries({
    MUSICDECK_PUBLIC_URL: "https://musicdeck.test",
    MUSICDECK_SESSION_SECRET: "isolated-compose-test-secret",
    MUSICDECK_ADMIN_PASSWORD: "isolated-compose-test-password",
    MUSIC_ROOT: directory.replaceAll("\\", "/"),
    ...overrides,
  })) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    contents = pattern.test(contents) ? contents.replace(pattern, `${key}=${value}`) : `${contents}\n${key}=${value}`;
  }
  fs.writeFileSync(envFile, contents);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MUSICDECK_|NAVIDROME_|JELLYFIN_|COMPOSE_|MUSIC_BACKEND$|MUSIC_ROOT$|PUID$|PGID$|SPOTDL_AUTO_UPDATE$)/.test(key)) {
      delete env[key];
    }
  }
  const result = spawnSync(command, [
    ...prefix, "--env-file", envFile, "--project-directory", root, "-f", path.join(root, file),
    ...profiles.flatMap((profile) => ["--profile", profile]), "config", "--format", "json",
  ], { encoding: "utf8", env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Compose rendering failed: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}

afterEach(() => {
  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe.each(["docker-compose.yml", "docker-compose.dev.yml"])("%s backend port security", (file) => {
  const production = file === "docker-compose.yml";

  test("backend bindings and image defaults follow the deployment policy", () => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).not.toContain("deluan/navidrome:latest");
    expect(source).not.toContain("jellyfin/jellyfin:latest");
    if (production) {
      expect(source).not.toContain('${MUSICDECK_VERSION:-latest}');
      expect(source).toContain('127.0.0.1:${NAVIDROME_PORT:-4533}:4533');
      expect(source).toContain('127.0.0.1:${JELLYFIN_PORT:-8096}:8096');
      expect(source).not.toMatch(/\$\{(?:NAVIDROME|JELLYFIN)_BIND\b/);
    } else {
      expect(source).toContain('${NAVIDROME_BIND:-0.0.0.0}:${NAVIDROME_PORT:-4533}:4533');
      expect(source).toContain('${JELLYFIN_BIND:-0.0.0.0}:${JELLYFIN_PORT:-8096}:8096');
    }
    for (const [key, value] of Object.entries(DEFAULT_ACQUISITION_LIMITS)) {
      const name = `MUSICDECK_ACQUISITION_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
      expect(source).toContain(`${name}: \${${name}:-${value}}`);
    }
  });

  test.skipIf(!available)("rendered defaults preserve onboarding and internal networking", () => {
    const { services } = render(file);
    for (const [name, port] of [["navidrome", 4533], ["jellyfin", 8096]] as const) {
      expect(services[name].ports).toEqual([expect.objectContaining({
        host_ip: production ? "127.0.0.1" : "0.0.0.0", published: String(port), target: port,
      })]);
      expect(services[name].networks).toHaveProperty("default");
      expect(services[name].profiles).toEqual([name]);
    }
    expect(services["musicdeck-server"].ports).toBeUndefined();
    expect(services["musicdeck-server"].networks).toHaveProperty("default");
    expect(services["musicdeck-server"].environment).toMatchObject({
      NAVIDROME_URL: "http://navidrome:4533",
      JELLYFIN_URL: "http://jellyfin:8096",
      SPOTDL_AUTO_UPDATE: "0",
      MUSICDECK_LOGIN_IP_MAX: "20",
      MUSICDECK_TRUSTED_PROXIES: "",
      MUSICDECK_PORT: "4534",
      MUSICDECK_ACQUISITION_MAX_PENDING: "50",
      MUSICDECK_ACQUISITION_SSE_PER_USER: "3",
      MUSICDECK_ACQUISITION_SSE_GLOBAL: "20",
    });
    expect(services["musicdeck-server"].expose).toContain("4534");
    expect(services["musicdeck-server"].healthcheck?.test.join(" ")).toContain("127.0.0.1:4534/api/health");
    const nginx = fs.readFileSync(path.join(root, "webapp/nginx.conf"), "utf8");
    expect(nginx).toContain("proxy_pass http://$musicdeck_upstream:4534");
    expect(nginx).toContain("Content-Security-Policy");
    expect(nginx).toContain("frame-ancestors 'self'");
    expect(nginx).toContain("X-Content-Type-Options");
    expect(nginx).toContain("Referrer-Policy");
    expect(nginx).not.toContain("Strict-Transport-Security");
    if (file === "docker-compose.yml") {
      expect(services["musicdeck-server"].environment?.MUSICDECK_SECURE_COOKIES).toBe("true");
      expect(services["musicdeck-web"].ports?.[0].host_ip).toBe("127.0.0.1");
    }
  });

  test.skipIf(!available)("host port overrides preserve the deployment's binding policy", () => {
    const { services } = render(file, {
      NAVIDROME_BIND: "192.0.2.10", NAVIDROME_PORT: "14533",
      JELLYFIN_BIND: "0.0.0.0", JELLYFIN_PORT: "18096",
      MUSICDECK_LOGIN_IP_MAX: "40", MUSICDECK_TRUSTED_PROXIES: "10.20.0.2",
      MUSICDECK_ACQUISITION_MAX_PENDING: "12", MUSICDECK_ACQUISITION_SSE_GLOBAL: "6",
    });
    expect(services.navidrome.ports).toEqual([expect.objectContaining({
      host_ip: production ? "127.0.0.1" : "192.0.2.10", published: "14533", target: 4533,
    })]);
    expect(services.jellyfin.ports).toEqual([expect.objectContaining({
      host_ip: production ? "127.0.0.1" : "0.0.0.0", published: "18096", target: 8096,
    })]);
    expect(services["musicdeck-server"].environment).toMatchObject({
      MUSICDECK_LOGIN_IP_MAX: "40", MUSICDECK_TRUSTED_PROXIES: "10.20.0.2",
      NAVIDROME_URL: "http://navidrome:4533", JELLYFIN_URL: "http://jellyfin:8096",
      MUSICDECK_ACQUISITION_MAX_PENDING: "12", MUSICDECK_ACQUISITION_SSE_GLOBAL: "6",
    });
  });

  test.skipIf(!available)("externally hosted backend URLs work without enabling backend containers", () => {
    const { services } = render(file, {
      NAVIDROME_URL: "https://navidrome.example.test",
      JELLYFIN_URL: "http://192.0.2.10:8096",
      MUSIC_BACKEND: "jellyfin",
    }, []);
    expect(services.navidrome).toBeUndefined();
    expect(services.jellyfin).toBeUndefined();
    expect(services["musicdeck-server"].environment).toMatchObject({
      NAVIDROME_URL: "https://navidrome.example.test",
      JELLYFIN_URL: "http://192.0.2.10:8096",
      MUSIC_BACKEND: "jellyfin",
    });
  });

  test.skipIf(!available || production)("development supports explicitly selecting host-local backend bindings", () => {
    const { services } = render(file, { NAVIDROME_BIND: "127.0.0.1", JELLYFIN_BIND: "127.0.0.1" });
    expect(services.navidrome.ports?.[0].host_ip).toBe("127.0.0.1");
    expect(services.jellyfin.ports?.[0].host_ip).toBe("127.0.0.1");
  });
});

describe("published MusicDeck image defaults", () => {
  function imageDefaults() {
    const source = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    return [...source.matchAll(/image: \$\{MUSICDECK_IMAGE_(?:WEB|SERVER):-([^}]+)\}:\$\{MUSICDECK_VERSION:-([^}]+)\}/g)]
      .map((match) => ({ repository: match[1]!, tag: match[2]! }));
  }

  test("web and server use the same explicit pin, documented in the environment template", () => {
    const images = imageDefaults();
    expect(images.map((image) => image.repository).sort()).toEqual([
      "ghcr.io/userphase/musicdeck-server", "ghcr.io/userphase/musicdeck-web",
    ]);
    expect(new Set(images.map((image) => image.tag)).size).toBe(1);
    expect(images[0]!.tag).toMatch(/^(?:sha-[a-f0-9]{7,40}|\d+\.\d+\.\d+)$/);
    expect(fs.readFileSync(path.join(root, ".env.example"), "utf8"))
      .toContain(`# MUSICDECK_VERSION=${images[0]!.tag}`);
    expect(fs.readFileSync(path.join(root, "docs/SELF_HOSTING.md"), "utf8"))
      .toContain(`\`${images[0]!.tag}\``);
  });

  // Opt in when reviewing/updating pins; ordinary tests remain offline.
  test.skipIf(process.env.MUSICDECK_TEST_IMAGE_REGISTRY !== "1")("both default image tags are published for amd64 and arm64", async () => {
    for (const { repository, tag } of imageDefaults()) {
      const name = repository.replace(/^ghcr\.io\//, "");
      const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`, {
        signal: AbortSignal.timeout(15_000),
      });
      expect(tokenResponse.status).toBe(200);
      const { token } = await tokenResponse.json() as { token: string };
      const manifest = await fetch(`https://ghcr.io/v2/${name}/manifests/${tag}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      expect(manifest.status, `${repository}:${tag} must be published`).toBe(200);
      const index = await manifest.json() as { manifests: Array<{ platform: { os: string; architecture: string } }> };
      for (const architecture of ["amd64", "arm64"]) {
        expect(index.manifests.some((entry) => entry.platform.os === "linux" && entry.platform.architecture === architecture)).toBe(true);
      }
    }
  }, 65_000);
});

describe("production LAN onboarding template", () => {
  test.skipIf(!available).each(["navidrome", "jellyfin"])("selecting %s keeps backend setup on loopback", (backend) => {
    const { services } = render("docker-compose.yml", {
      MUSIC_BACKEND: backend, MUSICDECK_PUBLIC_URL: "http://192.0.2.10:8080",
    }, [], true);
    expect(services[backend]).toBeDefined();
    expect(services[backend].ports?.[0].host_ip).toBe("127.0.0.1");
    expect(services[backend === "navidrome" ? "jellyfin" : "navidrome"]).toBeUndefined();
    expect(services["musicdeck-web"].ports?.[0]).toMatchObject({ host_ip: "0.0.0.0", published: "8080" });
    expect(services["musicdeck-server"].environment).toMatchObject({
      MUSICDECK_SECURE_COOKIES: "false", MUSICDECK_PUBLIC_URL: "http://192.0.2.10:8080",
      MUSICDECK_CORS_ORIGIN: "http://192.0.2.10:8080",
    });
  });

  test.skipIf(!available)("a LAN binding applies to MusicDeck Web while backend ports stay on loopback", () => {
    const { services } = render("docker-compose.yml", {
      MUSICDECK_WEB_BIND: "192.0.2.10", NAVIDROME_BIND: "192.0.2.10", JELLYFIN_BIND: "192.0.2.10",
      MUSICDECK_PUBLIC_URL: "http://192.0.2.10:8080",
    }, ["navidrome", "jellyfin"], true);
    expect(services["musicdeck-web"].ports).toEqual([expect.objectContaining({ host_ip: "192.0.2.10" })]);
    for (const name of ["navidrome", "jellyfin"]) {
      expect(services[name].ports).toHaveLength(1);
      expect(services[name].ports?.[0].host_ip).toBe("127.0.0.1");
    }
  });
});
