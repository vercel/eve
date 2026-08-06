---
"eve": patch
---

Preserve each tool executor's concrete return type through `defineTool`, so non-streaming tools no longer appear to return an async iterable. Allow `ctx.to()` to infer closed receive-target interfaces such as Slack's without requiring an index signature.
