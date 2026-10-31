# @eve/loops Extension Package

This private package is the source of the `eve/extensions/loops` extension: a `call.settled` hook that detects a turn repeating the same tool calls, a dynamic system instruction that nudges the model, and `ctx.cancel()` once the loop comes back.

Before writing code, read the installed eve package docs for extensions, hooks, instructions, and state.

## Boundaries

- Act only through public hook and instruction APIs: nudge through the dynamic system instruction in `extension/instructions.ts`, and stop through `ctx.cancel()`. Never add tools, replay nudges into history, or start turns.
- Keep detection and the nudge-then-stop policy in `extension/lib/loops.ts`, free of eve runtime imports, so unit tests cover them directly.
- Keep only fingerprints in state, never call inputs or outputs.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/loops/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/`, outside the discovered extension tree. Run typecheck, unit tests, eve's build, lint, and package-scoped formatting before completion.
