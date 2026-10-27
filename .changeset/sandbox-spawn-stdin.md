---
"eve": minor
---

`sandbox.spawn()` accepts `stdin: true`, which returns a process with a writable `stdin` stream. Closing the stream sends EOF. The Vercel and Docker sandboxes support it, and the just-bash sandbox rejects it for now. Custom providers receive `stdin` in `spawn()` and return a process with `stdin`, or eve rejects the call.
