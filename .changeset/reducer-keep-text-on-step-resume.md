---
"eve": patch
---

Fix `defaultMessageReducer` dropping an assistant text or reasoning block when a step resumes after an authorization (OAuth) flow. A resumed step reuses the same `stepIndex`, so the second block no longer overwrites the first — both now stay in `data.messages[].parts` in stream order.
