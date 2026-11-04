import { redactText, registerLogSecret } from "./logger.js";

const SENSITIVE_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;

export function redactConfig(
  config: Record<string, unknown>,
  mode: "omit" | "presence",
  secretKeys = new Set<string>(),
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return redactConfig(value as Record<string, unknown>, mode);
    return typeof value === "string" ? redactText(value) : value;
  };
  const register = (value: unknown): void => {
    if (typeof value === "string") registerLogSecret(value);
    else if (value && typeof value === "object") Object.values(value).forEach(register);
  };
  const result: Record<string, unknown> = {};
  // Register sibling secrets before redacting strings which may repeat them.
  for (const [key, value] of Object.entries(config)) {
    if (secretKeys.has(key) || SENSITIVE_KEY.test(key)) register(value);
  }
  for (const [key, value] of Object.entries(config)) {
    if (secretKeys.has(key) || SENSITIVE_KEY.test(key)) {
      if (mode === "presence") result[key] = Boolean(value);
    } else {
      Object.defineProperty(result, key, { value: visit(value), enumerable: true, configurable: true });
    }
  }
  return result;
}
