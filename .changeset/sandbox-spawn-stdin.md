---
"eve": patch
---

`sandbox.spawn({ stdin: true })` returns a process with a writable `stdin` stream; closing it sends EOF. The Vercel and Docker sandboxes support it, and just-bash and custom providers without stdin support reject the call.
