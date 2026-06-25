---
"eve": patch
---

Self-hosted `eve start` now registers the workflow queue handler for custom (non-Vercel) worlds, so jobs dispatched by a configured world no longer return `Unhandled queue` or leave runs stuck `pending` — and you no longer need `eve dev --no-ui` to run a local world in production. eve also fails fast at boot with an actionable error when a configured workflow world's `@workflow/*` version is incompatible with the line eve bundles, instead of surfacing a cryptic `ZodError` deep in workflow replay.
