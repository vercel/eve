---
"eve": minor
---

Remote agents speak protocol 3, and `child.opened` replaces `agent.started`. Protocol 1 and 2 callers still receive results, but turns requiring relayed approvals, questions, or sign-ins fail with an upgrade message; the eval `remoteUrl` field and matcher are removed.
