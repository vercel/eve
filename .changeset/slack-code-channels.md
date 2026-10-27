---
"eve": patch
---

Set `codeChannels: true` on `slackChannel()` to serve Slack code channels as one session per channel. The agent answers un-mentioned messages, replies top-level or in the thread a person wrote in, and follows Slack's session status and stop. The option also adds the code channel scopes and events to the app manifest. A code channel session has no thread: `threadTs` is empty or `null`, and `ctx.slack.codeChannel` marks it. Address its session with `{ channelId, codeChannel: true }` in `onEvent` targets, or with `slackCodeChannelContinuationToken(channelId)`.

Two changes also reach agents that don't enable code channels: a cancelled turn now clears the Slack thread status by default, and `SlackSessionTarget` is now a union, so code that reads `target.threadTs` must handle the `{ channelId, codeChannel: true }` variant. `SlackHandle` also gains a required `codeChannel` field, which affects code that builds a handle by hand.
