---
"eve": patch
---

Add experimental agent messaging behind `experimental.subagentPersistentSessions` in `agent.ts`. Opted-in agents keep delegated children alive after they answer: each child is owned by a lifecycle handle, settles every turn with an explicit outcome carrying its per-turn token usage, and parks instead of terminating. The parent's subagent tools gain an `agentId` parameter to continue a parked child, discoverable from a per-model-call `<agents>` system injection that lists only parked (resumable) children. An omitted, empty, or unknown `agentId` starts a fresh child; continuing a child that is still starting or working fails with `AGENT_BUSY`. Without the opt-in, children keep running as one-shot tasks. The subagent tool input schema no longer includes the unused `description` field.
