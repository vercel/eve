---
"eve": patch
---

A failed tool's `execute_tool` span now reports `error.type` as the thrown error's `name` when it isn't `Error` (set `name` on your error class to classify failures), and `call.settled` instrumentation events carry `errorName`. Monitors that counted tool failures through `error.type:ACTION_RESULT_FAILED` should count `agent.action.outcome:failed` instead.
