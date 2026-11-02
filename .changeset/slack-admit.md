---
"eve": minor
---

Slack agents now ignore Slack Connect conversations and guest accounts by default, and a new `slackChannel({ admit })` hook decides who may reach the agent on every Slack surface.

`admit` runs before any hook for messages, edits, `onEvent` callbacks, approval and question answers, `onInteraction` actions, slash commands, and shortcuts, and before `receive` or `ctx.send` starts a session in a conversation. The default, `defaultSlackAdmit`, refuses conversations shared with another organization, multi-channel and single-channel guests, and conversations or users Slack can't classify. To keep serving Slack Connect users or guests, pass `admit: () => true`, or call `defaultSlackAdmit` from your own policy.

The generated Slack app manifest now always requests `channels:read`, `groups:read`, `im:read`, `mpim:read`, and `users:read`, which the default needs to classify conversations and users. Add any missing scopes and reinstall the Slack app. Without them, eve refuses the requests it can't classify.
