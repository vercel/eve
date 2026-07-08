---
"eve": patch
---

Slack channel posts now preserve literal bare `@` tokens such as scoped npm packages instead of rewriting them into Slack mention markup. Explicit `<@USERID>` mentions and `thread.mentionUser(userId)` output continue to render as mentions.
