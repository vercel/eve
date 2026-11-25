---
"eve": patch
---

Run Slack's first-reply `chat.getPermalink` thread-root check alongside the in-flight status write instead of after it, so the first reply posts one Slack round trip sooner.
