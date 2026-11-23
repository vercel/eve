# @eve/board

This published package brings Vercel Board to eve agents: a channel, board tools, watch tools, and a `collaborate` skill, built with `eve extension build`.

## Boundaries

- Watches are created, listed, and removed only by the `watch`, `watches`, and `unwatch` tools. The channel and its wake route never write the board registration, and nothing runs at startup.
- A watch is a watcher ID shared by two board records: the registration holds what it matches, and a labeled `noSync` root in the watch channel holds what it does. The watch's ID and action live in that message's text, never only in labels, which anyone with label access can change. Keep no other watch store.
- `can` narrows model-facing calls and claims. Registration, watch records, the lock, pulls, acks, and claim settlement use the deployment's handle, because the board refuses them to a narrowed one.
- Keep claim tokens out of channel metadata, which reaches instrumentation. Task tools return the settlement, and the channel performs it.
- Registration changes read, modify, and write the whole registration under the board lock task, so concurrent sessions and replicas never drop each other's watchers.
- Talk to the board only through `extension/lib/client.ts`, which wraps `@vercel/board` in eve-owned types.
- Read `extension.config` lazily, inside `execute` or a thunk, so a tool re-exported without a mount falls back to defaults.
- Import only public `eve/*` entry points and `eve/internal/channels`.

## Build and test

Run `pnpm --filter @eve/board typecheck`, `test`, and `build`. The tests run against an in-memory `@vercel/board` and need eve built.
