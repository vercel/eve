---
"eve": patch
---

MCP connection tools whose input schema uses a top-level `oneOf`/`allOf`/`anyOf` union are now flattened to a single object schema before the model call. Anthropic rejects a top-level union in a tool's `input_schema` and fails the entire request with an HTTP 400 before the agent can respond, so one non-conforming third-party tool previously took down every tool in the turn. The flattened schema merges the union branches' properties (left optional, `additionalProperties` open) so no valid call is rejected, and the offending connection and tool name are logged. Nested unions are left untouched.
