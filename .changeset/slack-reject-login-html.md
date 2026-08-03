---
"eve": patch
---

Slack file fetches now reject the HTML sign-in page Slack returns when the bot token lacks the `files:read` scope, throwing an actionable error instead of passing the login HTML to the model as file content.
