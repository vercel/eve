---
"eve": patch
---

Reading a session stream whose history passed the World's retention now returns `410` with `code: "session_expired"` instead of a retryable `503` or `404`. The TypeScript client fails on the first response instead of retrying for about 38 seconds.
