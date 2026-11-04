---
"eve": patch
---

eve no longer adds a "Tool execution" note about parallel tool calls to every agent's system prompt.

Tool calls in one response still run in parallel. Without the note, Sonnet 5.5 solved a concurrency task in 93% of replayed eve-code runs instead of 75%, matching how pi, which runs tool calls in parallel without telling the model, performs.
