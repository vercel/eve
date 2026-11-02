---
"eve": minor
---

Add `isExternalSlackConversation` and `isSlackGuest` to `eve/channels/slack`, so a tool or schedule that posts to Slack can run the same Slack Connect and guest checks as `defaultSlackAllowFrom` first.
