---
"eve": patch
---

Validate every eve-owned tool call before execution or HITL handling: framework tools now carry live validating schemas, and durable or discovered JSON Schemas are rehydrated into validators so invalid calls are returned to the model for retry instead of throwing unrecoverable errors. OpenAPI operations whose schemas cannot be rehydrated are omitted with a warning, and subagent calls only enforce structured output when the model provides a non-empty `outputSchema` — an empty `{}` no longer fails the child run with `OUTPUT_SCHEMA_NOT_FULFILLED`.
