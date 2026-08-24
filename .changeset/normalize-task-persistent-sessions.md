---
"eve": minor
---

Persistent subagent sessions are now the default: subagent tools expose `agentId`, completed children remain available for follow-up messages, and eve publishes the `<agents>` listing automatically. Remove `experimental.subagentPersistentSessions` from agent configuration; `false` is no longer an opt-out.
