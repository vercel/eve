---
"eve": patch
---

Remote-agent dispatch now drops a model-supplied empty `outputSchema: {}` instead of forwarding it, matching local delegation. An empty object previously forced the remote session into structured-output task completion, which failed the call with `OUTPUT_SCHEMA_NOT_FULFILLED` even though the callee produced a correct prose result.
