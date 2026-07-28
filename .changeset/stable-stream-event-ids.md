---
"eve": minor
---

Every session stream event now carries a `meta.id`: a unique, `evt_`-prefixed ULID minted once when the event is written to the durable stream. Re-reading a stream — reconnecting from a cursor, rewinding to `startIndex=0`, or replaying a finished session — returns the same id for the same event, so it is safe to use as a primary key when persisting events (`on conflict (id) do nothing`). Note that a retried step re-emits its events under new ids, so the id deduplicates re-delivery, not re-emission. Authored hooks receive the same envelope.

Stream consumers now drop re-delivered events by id instead of guessing from payload content. `EveAgentStore` (and so the React, Vue, and Svelte bindings) no longer double-applies an `initialEvents` prefix that the live stream replays, and the dev TUI no longer renders a subagent's transcript twice when its child stream reopens.

**Breaking:** events read from a stream are now typed as `StampedHandleMessageStreamEvent`, which guarantees `meta` is present. `initialEvents` on `useEveAgent`/`EveAgentStore` requires that type, so a saved log typed as `HandleMessageStreamEvent[]` no longer typechecks — widen it to `StampedHandleMessageStreamEvent[]`. The `eve eval` API carries the stamped type end to end: turn, session, and live-turn `events`, `waitForEvent` results, and `eventsSatisfy` predicates all see `meta.id` without guards. Events persisted by an earlier version carry `meta.at` but no `meta.id`, so rewinding into a session that started before this release yields events whose id is absent despite the type. eve passes those through rather than dropping them, and they cannot be deduplicated; the exposure ends when those sessions do.
