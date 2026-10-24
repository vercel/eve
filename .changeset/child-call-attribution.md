---
"eve": patch
---

Parent sessions now record `child.sent` for each delivery a child accepts for one of their calls, and `agentCallActivity(state, callId)` in `eve/client` reports the child deliveries and turns a call caused, including turns several calls share. Child `delivery.admitted` facts no longer carry `source.caller`. Child observations that reached their captured tail report `"caught-up"` instead of `"idle"`.
