---
"eve": minor
---

Add `tags` to tools, connections, subagents, and remote agents so one approval policy can gate calls by what an entry does, through the new `toolTags` field on the approval context.

Tags are opaque strings eve doesn't interpret, such as `"reads:untrusted"` or `"effect:external"`. Connections take one list for every tool, or a `default` list with per-tool lists that replace it. eve also records an entry's tags on each `call.requested` event as `capability.tags` and on its tool span as `agent.tool.tags`.
