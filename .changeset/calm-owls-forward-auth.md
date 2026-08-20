---
"eve": patch
---

Forward the active caller on persistent local and remote subagent continuations so user-scoped connections resolve for the current turn without inheriting the previous caller's authority. Upgrade both remote-agent deployments before resuming existing persistent sessions; create-only receivers reject forwarded continuations rather than falling back to service authority.
