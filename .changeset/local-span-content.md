---
"eve": patch
---

Local trace spans now capture model and tool payloads: the system prompt, prompt messages, and response text/reasoning/tool calls on model spans, and call arguments/results on tool spans, each capped at 32 KB with provider transport metadata stripped. Set `EVE_TRACES_CONTENT=off` to keep payloads out of the spool.
