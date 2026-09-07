import { PLUGIN_CAPABILITIES, PLUGIN_PERMISSIONS, type MusicDeckPluginManifest, type PluginConfigField } from "./plugin-registry.js";

/** The only manifest schema version this server currently understands.
 * Bump this and add migration logic when the schema changes. */
export const CURRENT_MANIFEST_VERSION = 1;

const CONFIG_FIELD_TYPES = new Set(["string", "number", "boolean", "select", "url", "secret"]);

export type CustomPluginConfigurationField = {
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
};

/** Raw, untrusted manifest shape as parsed from an uploaded manifest.json. */
export type RawPluginManifest = {
  manifestVersion?: unknown;
  id?: unknown;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  capabilities?: unknown;
  permissions?: unknown;
  configuration?: unknown;
  updateUrl?: unknown;
  repository?: unknown;
};

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function fail(message: string): never {
  throw new ManifestValidationError(message);
}

/**
 * Validates an untrusted manifest.json payload for a custom (third-party)
 * plugin and converts it into the same MusicDeckPluginManifest shape used by
 * first-party plugins. Never executes anything from the manifest; it is
 * pure data validated against a fixed, versioned schema.
 */
export function parseCustomManifest(raw: unknown): MusicDeckPluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("Malformed plugin manifest");
  }

  const manifest = raw as RawPluginManifest;

  if (manifest.manifestVersion !== CURRENT_MANIFEST_VERSION) {
    fail(`Unsupported manifest version: ${String(manifest.manifestVersion)}`);
  }

  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)) {
    fail("Invalid plugin ID");
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail("Plugin name is required");
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    fail("Plugin version is required");
  }

  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    fail("Malformed plugin manifest: description must be a string");
  }

  if (manifest.author !== undefined && typeof manifest.author !== "string") {
    fail("Malformed plugin manifest: author must be a string");
  }

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    fail("Plugin must declare at least one capability");
  }
  for (const capability of manifest.capabilities) {
    if (typeof capability !== "string" || !PLUGIN_CAPABILITIES.has(capability)) {
      fail(`Unknown plugin capability: ${String(capability)}`);
    }
  }

  const permissions = manifest.permissions === undefined ? [] : manifest.permissions;
  if (!Array.isArray(permissions)) {
    fail("Malformed plugin manifest: permissions must be an array");
  }
  for (const permission of permissions) {
    if (typeof permission !== "string" || !PLUGIN_PERMISSIONS.has(permission)) {
      fail(`Unknown plugin permission: ${String(permission)}`);
    }
  }

  const fields: PluginConfigField[] = [];
  if (manifest.configuration !== undefined) {
    if (typeof manifest.configuration !== "object" || manifest.configuration === null || Array.isArray(manifest.configuration)) {
      fail("Malformed plugin manifest: configuration must be an object");
    }
    for (const [key, value] of Object.entries(manifest.configuration as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`Malformed configuration field: ${key}`);
      }
      const field = value as CustomPluginConfigurationField;
      if (typeof field.type !== "string" || !CONFIG_FIELD_TYPES.has(field.type)) {
        fail(`Unknown configuration field type for ${key}: ${String(field.type)}`);
      }
      fields.push({
        key,
        label: typeof field.label === "string" ? field.label : key,
        secret: field.type === "secret",
        required: Boolean(field.required),
        default: field.default,
      });
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    author: typeof manifest.author === "string" ? manifest.author : undefined,
    capabilities: manifest.capabilities as string[],
    permissions: permissions as string[],
    config: fields.length > 0 ? { fields } : undefined,
  };
}
