---
"eve": patch
---

Reject tool input schemas with a root-level union or a non-object root during `eve build`. Anthropic rejects these schemas on every request that lists the tool, so the build now names the tool and suggests wrapping the union in an object property, for example `z.object({ request: z.discriminatedUnion(...) })`.
