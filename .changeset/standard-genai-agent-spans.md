---
"eve": patch
---

Align local agent invocation and tool execution spans with the OpenTelemetry GenAI agent conventions. Agent turns now emit usage-bearing `invoke_agent` spans, model calls emit `chat` directly beneath `agent.step` without a redundant `ai.streamText` wrapper, tool calls emit `execute_tool` spans, and terminal failures include `error.type`. In experimental provider mode, channel requests use `agent.channel.request`; legacy instrumentation retains HTTP-semantic route names. The first terminal delivery for a turn parents its invocation, and Workflow SDK spans started from agent contexts remain on a separate trace. These naming changes advance the Agent Trace schema to version 3 while local readers retain version 2 compatibility.
