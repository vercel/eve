---
"eve": minor
---

Simplify workflow-tool delegation to `ctx.agent(target, input)`. eve now derives replay-stable invocation identities, so workflow authors no longer provide separate `key` and `target` fields, and inline output schemas infer the structured result type.
