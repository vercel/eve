---
"eve": minor
---

Tool calls now export one `execute_tool` span instead of an `agent.action` wrapper and a tool child. Durable outcomes, approvals, execution metadata, and subagent trace correlation stay on the tool span; the trace schema remains version 4.

`defineInstrumentation` no longer supports `action.*` handlers or `InstrumentationAction*` types; use `tool.call.*`, `InstrumentationToolCall*`, and `InstrumentationToolOutput` instead. Tool events now describe one durable call lifecycle, and start handlers read `event.toolName` instead of `event.name`.
