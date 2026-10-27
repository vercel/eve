---
"eve": patch
---

When a tool throws an error whose `name` is not `Error`, its `execute_tool` span's `error.type` is now that name, such as `GitBrokerRefusedError`, following OpenTelemetry's class-name convention for `error.type` and the exception class that Strands and LangChain tracers record. Instrumentation `call.settled` events gain an optional `errorName` on every trace. A plain `Error`, including Node's `ECONNRESET`, keeps `ACTION_RESULT_FAILED`: to classify such a failure, catch it and rethrow a named class, and match every thrown tool failure with `agent.action.outcome:failed`.
