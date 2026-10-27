---
"eve": minor
---

Add `eveChannel({ authorizeSession })` for per-session access checks across messages, controls, preparation, and streams. User principals now require an explicit policy to access existing sessions; non-user shared transports retain their existing default access.
