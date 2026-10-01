---
"eve": patch
---

`session.waiting`, `turn.waiting`, `session.failed`, and `session.completed` now carry `usage`, the session's running token usage and cost including what the agents it delegated to spent. Eval results expose it as `derived.usage`, per session and summed for the eval, so a delegating eval no longer reports only its own model calls.
