---
"eve": minor
---

Clients, evals and templates read v27 session facts.

- `eve/evals` adds `toolCallsOf(events)` and `turn.waitForToolCall(name, options)`, and
  event matchers can match a fact's `scope`. Eval tool calls always carry their `callId`.
- `toolResultFrom` also accepts a settled call row, such as `ctx.view.calls[callId]`.
- A relayed request's `interaction.opened` carries `origin.call`, the asker's call, so readers
  name a child's approval by the child's tool rather than by the delegating call.
- `MessageResult.status` keeps its meaning: `"waiting"` while the session stays open,
  `"completed"` once it ended.
- Client reducers, `toolCallState`, the ACP adapter, evals and invocations derive turns,
  requests, sign-ins, tasks and call statuses from the shared tables `eve/events` folds,
  instead of a second, client-only lifecycle fold.
- `eve/events` adds `foldReceivedEvent(view, event)`, for readers that update on each event,
  and `copyView(view)`, a cheap copy for readers that keep every state.
- `eve/svelte` and `eve/vue` no longer export the `SessionAuthorization`, `SessionCall` and
  `SessionProjection` types. `SessionCallStatus` remains.
