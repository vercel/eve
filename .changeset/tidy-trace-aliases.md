---
"eve": patch
---

Remove duplicate tool call IDs, error codes, and model provider attributes from agent traces. Runtime context no longer repeats structural channel, session, step, turn, and framework identifiers; trace schema remains version 4.
Model and activation spans now emit token counts only under `gen_ai.usage.*`; step and tool usage and cost values remain unchanged.
