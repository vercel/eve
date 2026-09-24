---
"eve": patch
---

Subagent calls start their child sessions directly instead of through a wrapper workflow run, and each child reports its address and result to the parent's session. Agent IDs now look like `researcher-7k2m9q`, the `[Tasks]` note (with an `<idle_agents>` block) replaces the `[Agents]` note, and an `agentId` that matches no agent in the session fails with `UNKNOWN_AGENT` instead of starting a new agent.
