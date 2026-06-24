---
"eve": patch
---

Give each threadless proactive Slack session a unique temporary continuation token so overlapping scheduled runs targeting the same channel do not conflict before they anchor to a Slack thread.
