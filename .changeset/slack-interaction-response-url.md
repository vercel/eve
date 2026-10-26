---
"eve": patch
---

Slack `onInteraction` actions now include `responseUrl`, the click's `response_url`. POST `{ delete_original: true }` or a replacement message to it to delete or update the message that hosts the button, including ephemeral messages that `chat.delete` and `chat.update` cannot reach.
