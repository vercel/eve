---
"eve": patch
---

Custom channel routes can now call `resetSession()` to retire the session that owns a stable continuation token. The next `send()` with that token starts a fresh workflow session instead of reusing prior history.
