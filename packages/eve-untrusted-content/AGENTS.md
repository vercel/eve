# @eve/untrusted-content Extension Package

This private package is the source of the `eve/extensions/untrusted-content` extension: a hook that records in `defineState` when a session reads untrusted content, and `untrustedContentPolicy()`, an agent-wide approval policy that acts on it.

Before writing code, read the installed eve package docs for extensions, hooks, state, and approvals.

## Boundaries

- Use only public eve APIs: entry `tags`, `defineState`, hooks, and the agent-wide `approval` policy. Don't change eve's harness, execution, or protocol for this extension.
- Keep the tag vocabulary, state transitions, and policy decisions in `extension/lib/untrusted-content.ts`, free of eve runtime imports, so unit tests cover them directly.
- Keep only tool names and call ids in state, never call inputs or outputs.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/untrusted-content/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/`, outside the discovered extension tree. The integration test lives in `packages/eve/src/extensions/untrusted-content/`. Run typecheck, unit tests, eve's build, lint, and package-scoped formatting before completion.
