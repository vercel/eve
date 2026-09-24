---
"eve": patch
---

Add `mcpCapabilitiesChannel` (from `eve/channels/mcp`), which publishes an agent's own tools and skills as a stateless MCP 2026-07-28 server. Tools run server-side in a real eve context, so `ctx.getSandbox()`, `ctx.getToken()`, and `ctx.getSkill()` work; callers reuse one sandbox per `eve-capability-session`, and approvals and sign-in come back as MCP input-required results.
