---
"eve": patch
---

Calling `prewarm()` on an existing session can now prepare an idle owner on the Vercel deployment accepting the request before the next message. Apps can trigger it when typing starts; it preserves the session, history, stream, and expiry, and does not block Send or run the model.

Preparation uses the existing `POST /eve/v1/session/:sessionId` endpoint with no body or `{}`. Requests with messages or input responses keep their existing behavior.
