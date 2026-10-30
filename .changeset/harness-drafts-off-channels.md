---
"eve": patch
---

Under an experimental `agent/harness.ts`, Slack, Linear, Chat SDK channels, and the ACP server no longer show the model's draft text, only the reply the harness settles with.

A draft part's first `content.delta` now carries `draft: true`, so streaming clients can skip it.
