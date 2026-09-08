---
"eve": minor
---

Emit a separate OpenTelemetry trace per agent activation, linked to its caller and correlated by conversation ID. Dispatch uses `agent.action` and `execute_tool` spans; only agent execution uses `invoke_agent`, with error privacy and usage preserved across worker replacement.
