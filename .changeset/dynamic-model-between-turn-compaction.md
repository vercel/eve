---
"eve": patch
---

Between-turn compaction now evaluates an agent's dynamic model with the session conversation before resolving the compaction model, fixing failures when no dynamic model selection was persisted yet or when a live dynamic model rebuilds on a cold invocation.

Thanks @xcscxr for reporting this in #6630.
