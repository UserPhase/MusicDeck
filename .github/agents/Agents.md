# MusicDeck Project Instructions

## Project

MusicDeck is a self-hosted music application with a Spotify-inspired
user experience and a Navidrome-focused backend architecture.

The project should prioritize:

- polished UX
- maintainable architecture
- strong typing
- accessibility
- performance
- reliability
- security
- backwards compatibility

## Architecture Principles

- Keep clear boundaries between UI, application logic, APIs, and external providers.
- Prefer reusable abstractions over duplicated implementations.
- Do not tightly couple the UI to a specific backend provider.
- External integrations should use provider abstractions where appropriate.
- Avoid speculative architecture for features that do not exist yet.
- Prefer small, incremental changes over broad rewrites.

## Coding Rules

- Inspect existing code before changing it.
- Reuse existing patterns and utilities.
- Avoid unnecessary dependencies.
- Avoid unrelated refactors.
- Preserve existing behavior unless the task explicitly changes it.
- Keep secrets and credentials out of source control.
- Add appropriate tests for changed behavior.
- Do not commit or revert user-owned changes.

## Project Documentation

Use repository documentation as the source of truth for project context.

- Read `AGENTS.md` for project-wide engineering rules.
- Read the relevant custom `.agent.md` instructions for the selected specialist agent.
- Read `docs/product.md` when the task involves product behavior, UX direction, feature prioritization, or product decisions.
- Read `docs/architecture.md` when the task involves architecture, data flow, boundaries, providers, shared abstractions, or cross-system changes.
- Read `docs/self_hosting.md` when the task involves Docker, deployment, configuration, production serving, storage, networking, or self-hosting.
- Read other documentation only when it is relevant to the current task.
- Do not read every documentation file by default.
- Prefer targeted reading of the minimum relevant documentation needed to complete the task correctly.
- If documentation conflicts with the actual code, treat the code as the source of truth for what is currently implemented and report the discrepancy.

## Task Scope

- Implement the smallest coherent change that satisfies the request.
- Do not silently expand scope.
- Fix unrelated issues only when they are required for the current task to work correctly.
- Defer unrelated architectural or cleanup work.
- Prefer focused validation for small changes.
- Use broader validation when shared infrastructure or multiple subsystems are affected.

## Efficiency

- Use the minimum repository context necessary for the task.
- Inspect relevant files before broad searches.
- Do not repeatedly rediscover information already available in project documentation.
- Avoid unnecessary repository-wide scans.
- Avoid unnecessary repeated builds and tests.
- Do not optimize for fewer tokens at the expense of correctness or quality.

## Documentation

Detailed architecture and phase specifications belong in `docs/`.

Do not place large feature specifications or temporary task instructions
in this file.