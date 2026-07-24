---
"eve": minor
---

Remote-agent session callbacks now carry an event envelope discriminated by `event.status` (`"notification" | "termination"`, with `"working"` and `"input_required"` reserved). Remote callees forward their `authorization.required`/`authorization.completed` events to the caller as notification callbacks, so a remote subagent's authorization prompts now surface on the caller's stream just like a local subagent's. The callback wire shape changed: caller and callee deployments must both run this version — a mixed-version remote-agent pair will reject each other's callbacks.
