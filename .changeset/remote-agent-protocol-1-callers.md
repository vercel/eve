---
"eve": patch
---

A remote agent on this release now serves callers on eve 0.66 through 0.68 instead of rejecting them with `REMOTE_AGENT_PROTOCOL_MISMATCH`, so you can upgrade remote agents before the deployments that call them. Those callers' turns, results, follow-ups, and resets work as before, and the remote agent's tool approvals and sign-in requests still reach the caller and accept its answers.
