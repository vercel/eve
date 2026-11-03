---
"eve": minor
---

Add `isExternalSlackConversation` and `isSlackGuest` to `eve/channels/slack`, so a tool that posts through `callSlackApi` can run the same Slack Connect and guest checks as `defaultSlackAdmit`.
