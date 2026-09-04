---
"eve": patch
---

Fix remote-agent progress and completion callbacks for Vercel services mounted at `/eve/v1`. The build no longer adds the protocol path twice, which caused callback 404s and left parent agents waiting without an answer or failure notification.

Failed callback attempts now emit error-level logs with HTTP status or transport failure, a token-redacted destination, and available call, task, and session identifiers.
