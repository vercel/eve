---
"eve": patch
---

eve's agent spans now come from the shared tracing library, and durable turns recover from one checkpoint per turn. Each tool call is still one `execute_tool` span, a local subagent's first turn still nests under its caller, and trace schema version 4 is unchanged.
