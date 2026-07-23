---
"eve": patch
---

Custom channel routes can now call `reset()` and `ClientSession` can reset the session that owns a stable continuation token. The next `send()` starts a fresh workflow session and lazily initializes a new session-scoped sandbox instead of reusing prior history or workspace state, and the `eve dev` TUI's `/new` performs that durable reset before clearing its transcript.
