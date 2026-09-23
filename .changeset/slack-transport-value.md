---
"eve": patch
---

Internal refactor of the Slack channel: the bot token and the Slack Web API call path are now carried as one transport value, built once in `slackChannel()` and handed to every builder, instead of a `botToken` threaded separately into each. No public API, behaviour or log output changes.
