---
"eve": minor
---

Slack now shows each turn's tasks in a live task card: one message, updated in place, with a row per task that shows its latest steps and how it ended. Add the new opt-in `plan` tool (`eve add tool/plan`) and the model's checklist appears on the card too. Slack also acknowledges a mention with `Thinking...` right away, even with a custom `onAppMention`, and clears it if the hook drops the message. While a turn waits on its tasks, the status names them and stays up until they finish. Public channels show a failed task as `Failed` without its error text.

`slackChannel({ events })` is replaced by `renderers`, which wrap eve's default rendering instead of replacing it; without `renderers`, eve renders with its default. Move `events: { … }` to `renderers: [{ events: { … } }]` and handlers behave as before; call the new `next` argument to keep eve's default, which replaces `input.requested`'s `defaultDeliver`. A renderer can also shape the task card with `taskCard(view, next)`. The experimental `activity` option and the `experimental_slackActivity*` renderers are removed.
