---
"eve": minor
---

Slack message hooks can return `status: "deferred"` to keep a message's turn quiet until a tool call finishes, and `guidance` to tell the model how to treat that one message, so an agent can follow a thread and stay silent with `no_reply` when a reply isn't meant for it.

`status: "deferred"` skips the `received` acknowledgement. Mentions and DMs outside code channels get that acknowledgement before their hook runs, so for them it keeps only the rest of the turn quiet. A message that isn't deferred and joins the turn shows the status again. eve adds `guidance` as a `<guidance>` block inside the message's `<slack_message>` or `<slack_message_edit>` block, after the metadata and before the content. The Slack docs show how to follow threads the agent already serves with `onMessage`.

Message edits now go through an app's own message hooks. Without an authored `onMessageEdited`, an edit goes to the hook a new message of the same kind would reach: `onDirectMessage`, then `onMessage`, for DMs; `onAppMention`, then `onMessage`, for messages that mention the agent; `onMessage`, then `onAppMention`, in code channels; and `onMessage` for other messages. Without those hooks, the built-in defaults send edits to DMs, code channel messages, and messages that mention the agent before or after the edit, and drop the rest. Edits are always quiet and ignore `status`, and an authored `onEvent` still comes before this default. The new `ctx.edit` is set while a hook decides an edit.

In 1.0.0-rc.2, an authored `onAppMention`, `onDirectMessage`, or `onMessage` turned off edits unless the app also defined `onMessageEdited`. Those hooks now also run for edits in threads that have a session. If a hook has side effects, such as `ctx.send()`, `ctx.end()`, or a decision model call, return early when `ctx.edit` is set. To keep edits off, define `onMessageEdited` and return `null`.
