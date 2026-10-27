---
"eve": patch
---

When a tool throws an error whose `name` is not `Error`, its `execute_tool` span's `error.type` is now that name, such as `GitBrokerRefusedError` or `TypeError`, in place of `ACTION_RESULT_FAILED`. Instrumentation `call.settled` events gain an optional `errorName` on every trace. A monitor that counts every thrown tool failure by `error.type:ACTION_RESULT_FAILED` should match `agent.action.outcome:failed`.
