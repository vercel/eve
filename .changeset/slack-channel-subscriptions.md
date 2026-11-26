---
"eve": minor
---

Add event subscriptions to `slackChannel`. `slackChannel({ experimental: { subscriptions: { onEvent, onSubscribe, events } } })` lets a session subscribe with `eve__subscribe` to Slack bot events, such as `reaction_added` or `message.channels`, scoped by the `team_id`, and optionally the `channel` and message `ts`, that the event has. `onEvent` filters and formats each delivery, and `describeSlackEvent` from `eve/experimental/channels/slack` builds the default message. `events` narrows what `eve__search` offers, and the generated Slack app manifest subscribes to those events and requests the bot scopes they need. `eve__subscribe` rejects a token of another workspace, an app with none of the event's scopes, and a channel the bot is not in.
