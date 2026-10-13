---
"eve": patch
---

Calling `prewarm()` on an existing session can now prepare an idle owner on the Vercel deployment accepting the request before the next message. Apps can trigger it when typing starts; it preserves the session, history, stream, and expiry, and does not block Send or run the model.
