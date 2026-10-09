---
"eve": patch
---

`cancel()` from `useEveAgent()` and `EveAgentStore` now stops a turn that an approval or other input answer resumed. Previously it sent no cancel request and the resumed turn ran to completion. `MessageResponse.cancel()` on a `ClientSession.respond()` response now targets that resumed turn too.
