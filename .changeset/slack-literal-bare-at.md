---
"eve": patch
---

The Slack channel now preserves literal bare `@` tokens in outbound messages instead of rewriting them into mention markup. Explicit `<@USER_ID>` mentions and `thread.mentionUser(userId)` continue to work.
