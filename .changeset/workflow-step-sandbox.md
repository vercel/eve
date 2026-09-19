---
"eve": patch
---

Workflow tools now open the session sandbox on demand through `ctx.getSandbox()` in authored steps, without an opt-in. Blocking and background workflows reconnect to the session sandbox across steps without passing live handles through workflow state.
