---
"eve": patch
---

Keep the `Workflow` orchestration tool root-only. Delegated subagent sessions can still call visible subagent tools directly until the configured depth cap, but eve no longer advertises `Workflow` from those child sessions.
