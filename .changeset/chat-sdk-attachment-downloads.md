---
"eve": patch
---

Files people send over Chat SDK adapters that download attachments, such as Slack, Google Chat, WhatsApp, and Twilio, now reach the agent instead of a URL the model provider can't open. eve downloads each one in the step with the adapter's credentials, rebuilt through the adapter's `rehydrateAttachment`; a failed download, or a file over 25 MB, reaches the agent as a short note.
