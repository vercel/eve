---
"eve": minor
"@vercel/agent-runs": patch
---

Failed turns and model attempts now record their eve error code, such as `MODEL_CALL_FAILED`, as `error.type` on their spans even when a trace policy redacts outputs, instead of `_OTHER`.

Instrumentation providers receive the same code as `errorCode` on `turn.settled`, `session.ended`, `model.settled`, and `model.retried` events. Unlike `error`, it is not content, so it is present whether or not the provider records outputs.
