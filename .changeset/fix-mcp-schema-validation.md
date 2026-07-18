---
"eve": patch
---

Tool schemas that cannot be rehydrated into local validators no longer fail the turn. Serialized JSON Schemas first retry rehydration as JSON Schema 2020-12 (so MCP `$defs` references validate correctly), and schemas outside the supported conversion subset (such as inline JSON Pointer `$ref`s) are now advertised to the model unchanged with validation left to the tool's own executor — OpenAPI operations with such schemas are kept instead of omitted.
