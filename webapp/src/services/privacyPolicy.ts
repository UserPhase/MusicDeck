import type { PrivacySnapshot } from "../api/privacy";

let current: PrivacySnapshot | null | undefined;
export function setBrowserPrivacy(snapshot: PrivacySnapshot | null | undefined) { current = snapshot; }
export function isBrowserIntegrationAllowed(category: keyof PrivacySnapshot["effective"]): boolean {
  return current === undefined ? true : Boolean(current?.effective[category]);
}
export function assertBrowserIntegrationAllowed(category: keyof PrivacySnapshot["effective"]) {
  if (!isBrowserIntegrationAllowed(category)) throw new Error("External integration disabled by server privacy policy");
}
