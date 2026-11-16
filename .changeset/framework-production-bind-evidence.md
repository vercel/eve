---
"eve": patch
---

Require the managed Next.js and Nuxt backend process to confirm its own successful bind before accepting traffic.

A competing process that claims the configured port during startup cannot satisfy readiness. Managed startup still works without an authored health route and preserves bounded cancellation and shutdown.
