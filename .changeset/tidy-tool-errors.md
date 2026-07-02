---
"eve": patch
---

Tool execution failures now return failed tool results to the model instead of leaving streamed tool calls without matching result history. Agents can recover from failed calls such as a missing `load_skill` target within the same turn.
