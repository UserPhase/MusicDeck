/*
 * In-progress plugins.
 *
 * These modules are intentionally NOT auto-registered by the server runtime
 * (see main.ts). They are kept here for development visibility and future
 * completion, but they must not appear in the active plugin set or the normal
 * Admin Plugins page.
 */

export {
  createSpotifyImporterPlugin,
  createDiscordPresencePlugin,
  createHomeAssistantPlugin,
  conservativeSpotifyMatch,
} from "./automation-plugins.js";

export {
  createAuthorizedExternalSourcePlugin,
  createDebridCloudSourcePlugin,
  DebridCloudSourceProvider,
  debridFileMatchesForTest,
} from "./external-source-plugins.js";

export { createSiteSourcesPlugin } from "./site-sources.js";
export { createArchiveOrgSourcePlugin } from "./archive-org-source.js";
export {
  createOnDemandLibraryPlugin,
  AuthorizedHttpAcquisitionProvider,
} from "./on-demand-library.js";
