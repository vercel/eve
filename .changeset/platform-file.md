---
"eve": minor
---

eve can now run on a platform you define: add an experimental `agent/platform.ts` whose default export is a `definePlatform()` declaration, and eve reads your deployment, storage, durable engine, and other platform services from it instead of its built-in Vercel platform.

The platform API ships under `eve/experimental/platform` and `eve/experimental/session` and has no compatibility promise yet. Without `agent/platform.ts`, eve behaves as before.

A platform's `Triggers` can run authored schedules when its build sets `schedules.authored`, so an entry build can have authored schedules.
