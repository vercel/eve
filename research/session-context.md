---
issue: https://vercel.slack.com/archives/C0BJZ4MHG92/p1790302243007379
status: implemented
last_updated: "2026-09-25"
---

# Application context at session creation

Applications currently route stable UI context through custom HTTP headers and auth attributes. `clientContext` instead supplies ephemeral model input, so it cannot directly select application behavior in session-started dynamic definitions.

Expose `useEveAgent({ sessionContext: { surface: "docs" } })` across frontend bindings and the same `sessionContext` creation option on `client.sessions.create()`. Authored code reads `ctx.session.context`, including dynamic resolvers, hooks, tools, and workflow tools.

- Accept a JSON object with or without a first message; omitted context reads as `{}`.
- Capture it before initialization and persist it across workflow steps and turns.
- Keep it fixed for that session. Reject replacement on follow-up POSTs; reconnects retain it, while a hook reset reuses its captured creation options for a new session.
- Keep child sessions independent; context is not inherited automatically.
- Keep application context separate from authenticated identity and from model prompts. No agent schema, type registry, or generated application types are introduced.

The transport feeds the existing session bootstrap and durable context serialization. Callback projections read that value; no new lifecycle or mutable state API is needed.
