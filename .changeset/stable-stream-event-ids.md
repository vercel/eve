---
"eve": minor
---

Every session stream event now carries a `meta.id`: a unique, `evt_`-prefixed ULID minted once when the event is written to the durable stream. Re-reading a stream — reconnecting from a cursor, rewinding to `startIndex=0`, or replaying a finished session — returns the same id for the same event, so it is safe to use as a primary key when persisting events (`on conflict (id) do nothing`). Authored hooks receive the same envelope.

Stream consumers now drop re-delivered events by id instead of guessing from payload content. `EveAgentStore` (and so the React, Vue, and Svelte bindings) no longer double-applies an `initialEvents` prefix that the live stream replays, and the dev TUI no longer renders a subagent's transcript twice when its child stream reopens.

**Breaking:** events read from a stream are now typed as `StampedHandleMessageStreamEvent`, which guarantees `meta` is present. `initialEvents` on `useEveAgent`/`EveAgentStore` requires that type, so a saved log typed as `HandleMessageStreamEvent[]` no longer typechecks — widen it to `StampedHandleMessageStreamEvent[]`. Events persisted by an earlier version carry `meta.at` but no `meta.id`, so sessions started before this release yield events with a missing id when rewound; read it as `event.meta?.id` until those sessions age out.
