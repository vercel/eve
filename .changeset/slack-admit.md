---
"eve": minor
---

Slack agents no longer answer, take approvals from, or post into Slack Connect conversations by default, and a new `slackChannel({ admit })` hook decides who may reach the agent on every Slack surface.

`admit` runs before any hook for messages, edits, `onEvent` callbacks, approval and question answers, `onInteraction` actions, slash commands, and shortcuts, and before `receive` or `ctx.send` starts a session in a conversation. The default, `defaultSlackAdmit`, refuses conversations shared with another organization and conversations Slack can't classify. To keep serving Slack Connect users, pass `admit: () => true`, or call `defaultSlackAdmit` from your own policy.

The generated Slack app manifest now requests `channels:read`, `groups:read`, `im:read`, and `mpim:read`, which `conversations.info` needs to classify interactions and outbound sends. Add these scopes and reinstall the Slack app. Without them, eve refuses approvals, slash commands, and sends.
