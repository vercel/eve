---
"eve": minor
---

`eveChannel({ onMessage })` can now return a `Response` to refuse a message, such as a `429` for a caller over its rate limit; eve sends it unchanged and creates no session and sends no message.
