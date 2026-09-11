---
"eve": patch
---

Record model input once using the OpenTelemetry `gen_ai.input.messages` schema. Local traces no longer serialize the duplicate `ai.prompt.messages` payload, avoiding binary attachment traversal.
