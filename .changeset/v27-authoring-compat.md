---
"eve": minor
---

Authored code keeps the v26 event API while sessions write v27 facts. Until the v27 authoring API is designed, eve translates each line a session writes into the v26 events that line stands for. These get the same keys, payloads, and handler signatures as before:

- `defineHook` handlers, including `*` and `ctx.cancel()`.
- `defineChannel` event handlers, with `session.failed` still taking `(data, channel)`.
- Built-in channels' `events` overrides and Slack `renderers`.
- `defineDynamic` resolvers.
- A session handle's `getEventStream()` and `getStreamTailIndex()`, which still count in v26 events.

The hook, channel, schedule, dynamic, connection, and subagent extension epochs are unchanged, and extensions built for them keep loading.

Built-in channels run their previous implementations on the translated events.

Translated events are derived, so a few details can differ from what earlier versions wrote:

- Event ids come from stream positions.
- `session.waiting` follows a settled turn, or a control applied between turns.
- `approval.candidate` reports only refused, failed, or expired responder answers.
- `agent.started` no longer carries a remote child's deployment.
- Step usage is the model run's recorded usage.

`eve/client`, `eve/react`, evals, and the HTTP stream read the v27 facts directly.
