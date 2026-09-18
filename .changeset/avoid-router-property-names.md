---
"eve": patch
---

`agentRouter()` now advertises model-supplied output schemas as permissive objects, avoiding unsupported JSON Schema `propertyNames` warnings on OpenAI models while preserving downstream object validation.
