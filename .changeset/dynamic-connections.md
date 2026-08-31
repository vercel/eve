---
"eve": patch
---

Allow `connections/` modules to use `defineDynamic` for caller-specific MCP and OpenAPI connection sets resolved at session or turn boundaries. Dynamic connections participate in ordinary discovery, auth, approval, and qualified tool calls, fail closed on resolver errors, and pin durable authorization to a stable resolved instance.
