---
"eve": patch
---

Add `eve/channels/resend`, a channel that holds email conversations through Resend with one session per email thread and threaded plain-text replies.

It accepts webhooks forwarded by Vercel Connect by default, or verifies Resend's own signatures with `webhookSecret`.
