---
"eve": patch
---

Agents can now opt into a model-facing tool output limit that writes oversized results to the session sandbox while preserving the full `action.result` for hooks, channels, clients, and observability. Successful spills emit a durable `tool.output.spilled` event and bounded trace metadata.
