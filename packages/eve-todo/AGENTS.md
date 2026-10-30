# @eve/todo Extension Package

This private package is the source of the `eve/extensions/todo` extension: a session checklist the model rewrites with one tool, shown back to it as a dynamic system instruction while work is open.

Before writing code, read the installed eve package docs for extensions, tools, instructions, and state.

## Boundaries

- Show the list to the model only through the dynamic system instruction in `extension/instructions.ts`, and keep `todo__write`'s model output to counts. Never replay the list into history: system instructions stay outside history, so compaction can't turn a finished list into a fresh-looking user message.
- Keep validation and rendering in `extension/lib/todos.ts` and the Slack card in `extension/lib/plan.ts`, free of eve runtime imports, so unit tests cover them directly. `packages/eve/src/extensions/todo/slack.ts` only wraps `plan.ts` as a Slack renderer.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/todo/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/`, outside the discovered extension tree. Run typecheck, unit tests, eve's build, lint, and package-scoped formatting before completion.
