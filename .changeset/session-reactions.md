---
"eve": minor
---

`defineDynamic` now takes `select` and `resolve` instead of an `events` map. `select` is required: it reads the session view synchronously, and returning `null` from it resolves once. `resolve` runs again only when the selection changes, and its result is available at every model call.

- **`resolve` is a function of its selection.** eve may call it again with the same selection, such as in another process. It runs outside the session's context and receives no facts, so reading session state there throws. Read state in `select`.
- **A dynamic model is a `model` field.** Use `defineDynamic` from `eve/models`, whose `resolve` returns the model or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`, or `auto()`. `agent.ts` itself can't be dynamic. A subagent keeps its `description` and makes its `model` dynamic the same way, or makes the whole subagent dynamic with `defineDynamic` from `eve`.
- **`auto()` decides once per turn.** Steering and tool calls don't decide again, and a step in another process reuses the model the turn chose. Its options can carry `modelContextWindowTokens` and `modelOptions`.
- **`view.turn` is the session's latest turn,** with its ID, status, and the input it opened with. Select `view.turn?.id` to resolve once per turn.
- **Hooks return intents.** Hooks take either `events` handlers or `select` and `resolve`, never both. They return `cancel(reason?)` or `compact({ reason? })` from `eve/hooks`, and `ctx.cancel()` is gone. Each `compact()` runs once per entry; return it under a new key in a map to compact again.
- **Dynamic tools no longer need durable callbacks.** `defineDurableCallback` and `defineDurableSchema` are gone. If a rebuilt tool no longer matches the declaration the model was offered, its calls fail.
- **Memory drops its compaction hooks and `visibility`.** Recall applies to each model call.
- **Dynamic remote agents can't carry `auth` or `headers`.** Use a static remote agent for authenticated upstreams.
