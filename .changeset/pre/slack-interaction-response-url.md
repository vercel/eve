---
"eve": patch
---

Slack `onInteraction` actions now include `responseUrl`, the click's `response_url`.

POST to it to replace or delete the message the click came from, including an ephemeral message, which `chat.update` and `chat.delete` can't change.
