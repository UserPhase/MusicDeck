# Trusted server extensions

Server extensions are optional administrator-enabled **executable code**, separate
from MusicDeck's existing catalog/provider plugin manifests. The first version
supports admin-only HTTP capabilities and cooperative audio-analysis tasks.
Core playback, downloads and library scans do not require extensions.
[Google Cast](google-cast.md) is a separate playback feature, not an extension.

## Installation and trust

Only install reviewed code from a trusted operator. Modules run in the same Node
process with the service account's privileges. The hook API reduces accidental
coupling; it is **not** an OS, network, memory, CPU or JavaScript security sandbox.
Import side effects, dependency code and non-cooperative native subprocesses
cannot be safely undone by MusicDeck. Use a separate service/process for heavy
computation and call it from bounded cooperative tasks. Extensions must not
perform unbounded CPU work on the server event loop.

The default directory is `./extensions` for a Node checkout and `/extensions`
in the server image. Override it with `MUSICDECK_EXTENSIONS_DIR`. For Docker,
mount reviewed files read-only on the **MusicDeck server** service:

```yaml
services:
  musicdeck-server:
    volumes:
      - ./extensions:/extensions:ro
```

The MusicDeck runtime user needs read/traverse access. The server never downloads,
uploads, installs packages for, or writes executable extension files. Keep
dependencies inside the reviewed installation, and never place credentials in
manifests.

Each direct child directory must match its manifest ID:

```text
extensions/
  sonic-recommendations/
    extension.json
    index.mjs
```

`extension.json` is strict JSON (at most 16 KiB):

```json
{
  "apiVersion": 1,
  "id": "sonic-recommendations",
  "name": "Sonic Recommendations",
  "version": "1.0.0",
  "description": "Optional cooperative audio-analysis capability",
  "entry": "index.mjs"
}
```

IDs use lowercase letters, digits and hyphens, begin with a letter/digit and
have at most 80 characters. Entry points are fixed to `index.mjs`. Extension
directories, manifests and entry files must not be symlinks/junctions.
The configured root may be a container mount. These checks prevent accidental
path escapes; they do not make malicious code or its imports trustworthy.

In **Admin > Plugins > Server extensions**, choose **Scan extensions** and
review the inventory, then enable the module. Discovery reads metadata but
never imports disabled modules. New directories can be installed and discovered
while the server is running. Replacing discovered code requires a server restart:
manifest/entry fingerprints are checked before activation, and ESM module caches
are not repeatedly cache-busted. Review the entire dependency tree before
deploying replacement code; the fingerprint is not a package signature.

## Version 1 hook contract

The complete TypeScript API is exported by
[`ExtensionManager.ts`](../server/src/services/ExtensionManager.ts):

- `default`: a **synchronous factory** returning `ExtensionHooks`. A fresh hooks
  object is created on each enable; importing the module may happen only once
  per process. Keep resources inside the lifecycle, not at module top level.
- `onServerStart(context)`: awaited on enable and for persisted enabled modules
  at process startup. The context has the extension ID, a lifecycle `signal`,
  redacting `logging`, privacy-gated `network.fetch`, and
  `tasks.registerAudioAnalysis(definition)`.
- `registerRoutes(register)`: called after startup, before admission. It can be
  async, but must complete all registrations before returning. Methods are
  GET/POST/PUT/PATCH/DELETE. Paths are exact literals such as `/health` or
  `/vectors/status`, not URL patterns or wildcards. An extension may register
  at most 100 routes.
- `interceptTaskRunner(task, context, next)`: optional cooperative middleware for
  `AUDIO_ANALYSIS` only; core download/scan runners bypass extensions. Await
  `next()` once before returning to wrap the existing runner, or handle analysis without calling
  it. Errors fail the task; duplicate `next()` calls are rejected. Middleware
  cannot bypass task admission/payload validation.
- `onServerStop()`: awaited after admitted routes/tasks have drained, on disable,
  startup rollback and server shutdown. It must release owned timers, connections,
  workers and child processes and be safe to retry after a partial cleanup error.

An analysis `TaskDefinition<unknown>` has `validate(payload): payload is T`
and `run(payload, context): Promise<void>`. Only one analysis runner may be
registered across all enabled extensions/core workers; collisions fail and roll
back the new activation, never replace another runner. Interception can be used
without supplying a runner when another worker already owns analysis.

### Executable module example

This module exposes readiness and an observable, cancellable analysis-capability
probe. It does not claim to implement sonic vectors or recommendations:

```js
// index.mjs
export default function createExtension() {
  let enabled = false;
  return {
    async onServerStart(context) {
      context.signal.throwIfAborted();
      enabled = true;
      context.tasks.registerAudioAnalysis({
        validate(payload) {
          return payload !== null && typeof payload === "object" &&
            payload.operation === "capability-probe";
        },
        async run(_payload, task) {
          await task.checkpoint();
          task.throwIfCancelled();
          task.report({ percent: 100, itemsProcessed: 1, totalItems: 1,
            message: "Extension analysis lifecycle is operational" });
        }
      });
    },
    registerRoutes(register) {
      register("GET", "/health", async (_request, _reply, signal) => {
        signal.throwIfAborted();
        return { enabled, analysis: "capability-probe" };
      });
    },
    async interceptTaskRunner(_task, context, next) {
      await context.checkpoint();
      await next();
    },
    async onServerStop() {
      enabled = false;
    }
  };
}
```

The health URL is
`GET /api/v1/admin/extensions/sonic-recommendations/routes/health`.
The existing admin task API can enqueue:

```json
{
  "type": "AUDIO_ANALYSIS",
  "payload": { "operation": "capability-probe" }
}
```

Every extension route goes through the fixed Fastify gateway and normal live
session/admin guard; a module is never handed the raw Fastify instance or
permission to register arbitrary unauthenticated routes. Request bodies retain
the server's usual size/parser limits. Route handlers receive an AbortSignal and
must cooperate with it; do not hijack the raw socket or start untracked work.

## Cancellation, failure and persistence

Enable/disable/discovery mutations are serialized. Successful enablement is
persisted in SQLite; a failed new activation remains inactive and reports an
error. Persisted modules that fail startup do not prevent local playback from
starting, but remain visibly failed and log the cause. Missing enabled
installations remain reported in discovery issues on each scan. Restore their
reviewed files and scan again to disable their persisted intent through the panel.

Disable removes routes/interceptors/runner admission immediately, aborts the
lifecycle, cancels tasks currently executing extension code and waits for them
and admitted handlers to finish before cleanup. Analysis uses the existing
TaskManager priorities, progress, CPU/memory limits and media-stream yielding.
Call `checkpoint()` between bounded work units and observe `signal`; manage
subprocess termination with `onCancel()`. Pending analysis tasks and schedules
remain in the scheduler until a compatible runner is enabled again, or an
administrator cancels/disables them through the task controls.

A disable operation does not report success until cleanup finishes. Failed
cleanup retains an unavailable error-state runtime; use **Finish cleanup** to
retry. Non-cooperative code may keep disable/shutdown pending indefinitely.
MusicDeck will not pretend that it unloaded such code. Shutdown aborts extension
work in `preClose`, before Fastify waits for in-flight requests. Shutdown itself
does not clear persisted enabled intent.

Extensions must use `context.network.fetch` for outbound HTTP so Local-Only and
granular privacy policies still apply, including startup and background work
outside HTTP requests. Its requests also observe lifecycle cancellation.
Native `fetch`, raw sockets, third-party
clients and module top-level side effects are not sandboxed by this context.
Review extensions accordingly and use OS/container egress controls for strict
network isolation.

## Administration endpoints

All routes below require an administrator session and never accept filesystem
paths or code from a browser:

- `GET /api/v1/admin/extensions`: inventory and installation issues.
- `POST /api/v1/admin/extensions/discover`: rescan local installations.
- `PATCH /api/v1/admin/extensions/:id`: strict `{ "enabled": boolean }`.
- `/api/v1/admin/extensions/:id/routes/*`: enabled module's exact admin routes.

Errors use the normal API envelope, with `EXTENSION_NOT_FOUND` (404),
`EXTENSION_CONFLICT` (409), `EXTENSION_FAILED` (500) or `VALIDATION_ERROR` (400).
Policy-blocked outbound requests from module routes retain the normal 403
`LOCAL_ONLY_MODE_ACTIVE` / `EXTERNAL_INTEGRATION_DISABLED` error codes.
Detailed module exceptions stay in server logs rather than exposing private
installation paths in API responses.
