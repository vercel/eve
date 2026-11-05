# @eve/board Extension Package

This private package is the source of the `eve/extensions/board` extension: a `@vercel/board` channel, board tools, and a `collaborate` skill.

## Boundaries

- The channel lives in eve (`eve/channels/board`), which owns the board client, registration, and delivery. `extension/channels/threads.ts` only binds it to the mount's config through `eve/internal/board`.
- Tools act through the same client. Read `extension.config` lazily, inside `execute` or a thunk, so a tool re-exported without a mount falls back to `BOARD_URL`.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/board/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json` and `packages/eve/src/extensions/board/`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only `eve/*` exports from `extension/`. Run typecheck, the integration tests (they need eve built), and eve's build before completion.
