---
"eve": patch
---

Record `gen_ai.execute_tool.duration` on `execute_tool` spans, as `@ai-sdk/otel` does. Instrumentation providers also receive the tool's run time as `durationMs` on `tool.call.completed`.
