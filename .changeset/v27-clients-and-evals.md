---
"eve": minor
---

Clients, evals and templates read v27 session facts.

- `eve/evals` adds `toolCallsOf(events)` and `turn.waitForToolCall(name, options)`, and
  event matchers can match a fact's `scope`. Eval tool calls always carry their `callId`.
- `t.target.watchTurn(sessionId, { until })` ends a read that ends no turn, such as a context
  change between turns, and `session.compact()` returns once its context change settles.
- `toolResultFrom` also accepts a settled call row, such as `ctx.view.calls[callId]`.
- A relayed request's `interaction.opened` carries `origin.call`, the asker's call, so readers
  name a child's approval by the child's tool rather than by the delegating call.
- `MessageResult.status` keeps its meaning: `"waiting"` while the session stays open,
  `"completed"` once it ended.
- Client reducers, `toolCallState`, the ACP adapter, evals and invocations derive turns,
  requests, sign-ins, tasks and call statuses from the shared tables `eve/events` folds,
  instead of a second, client-only lifecycle fold.
- `eve/events` adds `foldReceivedEvent(view, event)`, for readers that update on each event,
  and `copyView(view)`, a cheap copy for readers that keep every state. A run row carries its
  `step` within its turn, and a turn row its `runs` count.
- `eve/svelte` and `eve/vue` no longer export the `SessionAuthorization`, `SessionCall` and
  `SessionProjection` types. `SessionCallStatus` remains.
- Text a model writes while its turn holds for tasks is narration in every session, not only in
  child and schedule sessions, so it isn't part of `turn.settled.reply` and channels don't post
  it. The task prompt tells the model to call `eve__task_wait` instead.
- `sessions.attach().stream()` reads a stranded predecessor that an eve before v27 recorded as a
  transcript: its v26 user messages, assistant text, clears, and end arrive as the v27 facts
  `transcriptReducer` reads. Other v26 events stay unreadable.
