---
"eve": patch
---

Replace repeated `[Agents]` registry snapshots with compact, append-only `<agent>` lifecycle messages. Each message now reports only the agent whose status changed while preserving the provider prompt-cache prefix.
