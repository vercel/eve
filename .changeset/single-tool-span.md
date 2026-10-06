---
"eve": patch
---

Tool calls now export one `execute_tool` span instead of an `agent.action` wrapper and a tool child. Durable outcomes, approvals, execution metadata, and subagent trace correlation stay on the tool span; the trace schema remains version 4.
