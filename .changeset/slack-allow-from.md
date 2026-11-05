---
"eve": minor
---

Slack agents now ignore Slack Connect conversations and guest accounts by default, and a new `slackChannel({ allowFrom })` option decides who can reach the agent.

eve checks `allowFrom` before any hook for messages, edits, `onEvent` callbacks, approval and question answers, `onInteraction` actions, slash commands, and shortcuts. The default, `defaultSlackAllowFrom`, refuses conversations shared with another organization, multi-channel and single-channel guests, and conversations or users Slack can't classify. Pass your own function to change the policy, calling `defaultSlackAllowFrom` from it to keep the default checks, or `() => true` to keep serving everyone.

The generated Slack app manifest now always requests `channels:read`, `groups:read`, `im:read`, `mpim:read`, and `users:read`. Self-managed apps created before this release usually lack `users:read`, so add any missing scopes and reinstall the Slack app. Until then, eve refuses the requests it can't classify, logs an error naming the missing scope, and tells the person who asked.
