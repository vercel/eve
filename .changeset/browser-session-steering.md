---
"eve": minor
---

Allow frontend `useEveAgent` bindings to queue or steer messages during an active turn with an explicit `turnPolicy`, and expose browser-local `pendingSubmissions`. `send()` now resolves when eve accepts the durable delivery; observe turn settlement through reactive state or `onFinish`.
