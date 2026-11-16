---
"eve": minor
---

Channel event handlers can pass work the turn doesn't depend on to `ctx.waitUntil(task)`, and the Slack channel uses it so its status updates no longer delay each model call.

Handlers still block the turn by default. eve waits for `waitUntil` work before the step that ran the handler ends, and inside a model call before that call ends, including when the turn is cancelled. It logs a rejection instead of failing the turn, stops waiting after 30 seconds with a warning, and warns about a `waitUntil` call made after the step ended. A cancelled turn now also keeps the channel state its handlers left.

`ChannelEventContext` gains a `waitUntil` member, as values eve passes into your code can in a minor release. A test fixture that builds the context by hand to call a handler directly needs to add one, for example `waitUntil: () => {}`.
