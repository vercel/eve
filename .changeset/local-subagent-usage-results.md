---
"eve": patch
---

Subagents now report their token usage back to the caller — local, runtime, and remote alike. A delegated subagent's terminal result carries the child session's token totals; remote agents transport the same totals over the session callback, and the caller projects them onto the result. The parent's turn emits one `invoke_agent` span per usage-bearing result (`gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.usage.*`, per the OpenTelemetry GenAI semantic conventions) in the caller's trace. Remote usage requires both sides to run this version; collection stays best-effort everywhere.
