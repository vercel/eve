---
issue: https://github.com/vercel/eve/pull/3797
status: implemented
last_updated: "2026-09-29"
---

# Application context at session creation

Applications currently route stable UI context through custom HTTP headers and auth attributes. Creation context is available before the first turn, including during prewarming; per-turn page context is available alongside it.

Expose `useEveAgent({ sessionContext: { surface: "docs" } })` across frontend bindings and the same `sessionContext` creation option on `client.sessions.create()`. Authored code reads `ctx.session.context`, including dynamic resolvers, hooks, tools, and workflow tools.

- Accept a JSON object with or without a first message; omitted context reads as `{}`.
- Capture it before initialization and persist it across workflow steps and turns.
- Keep it fixed for that session. Reject replacement on follow-up POSTs; reconnects retain it, while a hook reset reuses its captured creation options for a new session.
- Keep child sessions independent; context is not inherited automatically.
- Expose the current turn's `clientContext`, as sent, as `ctx.turn.context`, alongside creation context at `ctx.session.context`. Turns without it expose `undefined`.
- Carry turn context across steps of that turn and into workflow tools launched by it, then discard it at turn completion.
- Keep application context separate from authenticated identity. Session context stays out of model prompts; `clientContext` retains its existing model context messages. No agent schema, type registry, or generated application types are introduced.

The transport feeds the existing session bootstrap and durable context serialization. Turn context travels with the existing ephemeral client-context state. Workflow dispatch snapshots it for the launching turn.
