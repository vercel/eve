# @eve/private-context Extension Package

This private package is the source of the `eve/extensions/private-context` extension: a hook that records in `defineState` whose personal data a session read, and approval policies that act on it and on `ctx.session.audience`.

Before writing code, read the installed eve package docs for extensions, hooks, state, and approvals.

## Boundaries

- Use only public eve APIs: entry `tags`, `defineState`, hooks, `ctx.session.audience`, and the agent-wide `approval` policy. Don't change eve's harness, execution, or protocol for this extension.
- Stay independent of `eve/extensions/taint`: an agent can mount either one or both, and `strictest()` combines their policies.
- Keep state transitions and policy decisions in `extension/lib/private-context.ts`, free of eve runtime imports, so unit tests cover them directly.
- Keep only principal ids, tool names, and call ids in state, never call inputs or outputs.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/private-context/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/`, outside the discovered extension tree. The integration test lives in `packages/eve/src/extensions/private-context/`. Run typecheck, unit tests, eve's build, lint, and package-scoped formatting before completion.
