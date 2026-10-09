---
"eve": patch
---

Connection approval policies now receive `toolAnnotations`, the hints an MCP server declared for the called tool (such as `readOnlyHint` and `destructiveHint`), so a policy can skip approval for read-only tools. It is `undefined` when the server declares none.
