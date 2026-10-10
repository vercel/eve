---
"eve": minor
---

`defineDynamic` now takes `select` and `resolve` instead of an `events` map. `select` reads the session view synchronously. `resolve` runs again only when the selection changes, and its result is available at every model call.

- **Dynamic models move to `agent.ts`.** A dynamic `agent.ts` returns `defineAgent({ model, ... })` from `resolve`. A dynamic `model:` field is no longer accepted.
- **Hooks return intents.** Hooks return `cancel(reason?)` or `compact(key?)` from `eve/hooks`; `ctx.cancel()` is gone. Hooks can still use an `events` map.
- **Dynamic tools no longer need durable callbacks.** `defineDurableCallback` and `defineDurableSchema` are gone. If a rebuilt tool no longer matches the declaration the model was offered, its calls fail.
- **Memory drops its compaction hooks and `visibility`.** Recall applies to each model call.
- **Dynamic remote agents can't carry `auth` or `headers`.** Use a static remote agent for authenticated upstreams.
