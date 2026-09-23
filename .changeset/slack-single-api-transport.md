---
"eve": patch
---

The Slack channel's `views.open` and answered-card `chat.update` now go through the channel's own Slack API transport. Slack sees the same calls, and a `views.open` that fails after Slack responds is still logged and acknowledged.

A failed `views.open` is now logged as `Slack views.open failed` with the error attached, where it was `Slack views.open returned non-2xx` with a `status` field. Alerts or log queries keyed on either need updating.
