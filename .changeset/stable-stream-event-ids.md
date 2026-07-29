---
"eve": minor
---

Every session stream event now carries a stable, `evt_`-prefixed ULID in `meta.id`, and stream consumers use it to drop re-delivery without collapsing distinct events. Retried steps re-emit under new ids, while reconnects, rewinds, and saved-log overlap preserve the original id.

**Breaking:** `MessageStreamEvent` is now the canonical public type for events read from a stream, with `meta.id` and `meta.at` required. `HandleMessageStreamEvent` remains as a deprecated alias, so existing imports continue to compile; code that constructs unstamped events under that type must add the envelope. Client, channel, hook, frontend, and eval APIs carry `MessageStreamEvent` end to end, so consumers can read `meta.id` without guards. Events persisted by an earlier version carry `meta.at` but no `meta.id`, so rewinding into a session that started before this release yields events whose id is absent despite the type. eve passes those through rather than dropping them, and they cannot be deduplicated; the exposure ends when those sessions do.
