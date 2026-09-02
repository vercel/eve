---
"eve": patch
---

Structured output is now parsed before it lands in `result.completed`. When the model double-encodes the `final_output` payload as a JSON string, clients receive the parsed object instead of a raw string; an unparseable payload fails the turn as `OUTPUT_SCHEMA_NOT_FULFILLED` rather than being emitted verbatim.
