---
"eve": patch
---

Custom channel routes and `ClientSession` can now retire the session that owns a stable continuation token. The next `send()` starts a fresh workflow session instead of reusing prior history, and the `eve dev` TUI's `/new` performs that durable reset before clearing its transcript.
