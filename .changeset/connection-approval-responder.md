---
"eve": patch
---

A connection's `headers` and `toolCall.providedArguments` callbacks now receive `ctx.approval.responder` while an approved tool call runs, so an MCP or OpenAPI server can act for the person who approved it.

The call still runs as the requester, and its `auth` token stays the requester's. `ctx.approval` is absent for calls that needed no approval and while eve lists the connection's tools.
