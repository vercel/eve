---
"eve": minor
---

`defineDynamic` now takes `select` and `resolve` instead of an `events` map. `select` is required: it reads the session view synchronously, and returning `null` from it resolves once. `resolve` runs again only when the selection changes, and its result is available at every model call.

- **`resolve` is a function of its selection.** eve may call it again with the same selection, such as in another process. It runs outside the session's context and receives no facts, so reading session state there throws. Read state in `select`.
- **Dynamic models move to `agent.ts`.** A dynamic `agent.ts` returns `defineAgent({ model, ... })` from `resolve`. A dynamic `model:` field is no longer accepted.
- **Hooks return intents.** Hooks take either `events` handlers or `select` and `resolve`, never both. They return `cancel(reason?)` or `compact({ reason? })` from `eve/hooks`, and `ctx.cancel()` is gone. Each `compact()` runs once per entry; return it under a new key in a map to compact again.
- **Dynamic tools no longer need durable callbacks.** `defineDurableCallback` and `defineDurableSchema` are gone. If a rebuilt tool no longer matches the declaration the model was offered, its calls fail.
- **Memory drops its compaction hooks and `visibility`.** Recall applies to each model call.
- **Dynamic remote agents can't carry `auth` or `headers`.** Use a static remote agent for authenticated upstreams.
