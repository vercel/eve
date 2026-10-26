---
"eve": patch
---

Parent session streams now record accepted child deliveries as `child.sent`; use `agentCallActivity(state, callId)` from `eve/client` to inspect per-call child activity, including shared turns.
