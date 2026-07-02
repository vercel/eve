---
"eve": patch
---

Resuming a durable session whose history references a file attachment no longer fails the turn when the staged bytes are gone (for example after a redeploy pointed the session at a fresh sandbox). The missing attachment degrades to a `FileNotFound` text notice the model can interpret, so the run continues instead of ending in `session.failed`.
