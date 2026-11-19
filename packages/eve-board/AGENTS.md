# @eve/board

This published package brings Vercel Board to eve agents: a channel, board tools, watch tools, and a `collaborate` skill, built with `eve extension build`.

## Boundaries

- Watches are created, listed, and removed only by the `watch`, `watches`, and `unwatch` tools. The channel, its start hook, and its wake route never write the board registration.
- A watch is a watcher ID shared by two board records: the registration holds what it matches, and a labeled `noSync` root in the watch channel holds what it does. Keep no other watch store.
- Registration changes read, modify, and write the whole registration under the board lock task, so concurrent sessions and replicas never drop each other's watchers.
- Talk to the board only through `extension/lib/client.ts`, which wraps `@vercel/board` in eve-owned types.
- Read `extension.config` lazily, inside `execute` or a thunk, so a tool re-exported without a mount falls back to defaults.
- Import only public `eve/*` entry points and `eve/internal/channels`.

## Build and test

Run `pnpm --filter @eve/board typecheck`, `test`, and `build`. The tests run against an in-memory `@vercel/board` and need eve built.
