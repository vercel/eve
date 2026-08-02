---
"eve": patch
---

Fail loudly when a Slack private file fetch returns a login HTML page (HTTP 200)
instead of the file bytes. This happens when the bot token is missing the
`files:read` scope or the app has not been reinstalled since the scope was
added; staging the HTML as the attachment previously made the model report a
Slack sign-in page without any indication of the underlying misconfiguration.
The fetch now throws an error naming `files:read` and the reinstall step.
