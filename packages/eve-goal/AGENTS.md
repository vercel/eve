# @eve/goal Extension Package

This private package is the source of the `eve/extensions/goal` extension: a durable session goal, a judge that runs after every turn, and follow-ups through hook `ctx.followUp()`.

Before writing code, read the installed eve package docs for extensions, hooks, tools, instructions, and state.

## Boundaries

- Only the judge marks a goal met or impossible. The model may set a goal; pausing, resuming, and clearing require the person's approval.
- Keep the loop's guards and verdict handling in `extension/lib/policy.ts`, free of eve runtime imports, so unit tests cover them directly.
- Continue only through `ctx.followUp()` from `turn.settled`. Never add another way to start turns.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/goal/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/`, outside the discovered extension tree. Run typecheck, unit tests, eve's build, lint, and package-scoped formatting before completion.
