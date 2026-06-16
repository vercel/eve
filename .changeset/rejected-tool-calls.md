---
"eve": patch
---

Emit a `rejected` `action.result` stream event when a tool call is denied at a HITL approval gate. Denied calls previously left no trace in the session stream (the denial lived only in model history), so consumers like observability never saw the tool call resolve. The `action.result` status union now includes `rejected`, and the message stream version is bumped to `16`.
