---
"eve": patch
---

Clear pending connection/tool authorization state after a matching callback resumes a session, so Slack threads do not keep waiting for already-completed auth and swallow follow-up messages.
