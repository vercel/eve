---
"eve": patch
---

Sandbox commands now run with `AI_AGENT=eve` by default, so agent-aware CLIs such as `vercel` switch to their non-interactive agent mode. Set `AI_AGENT` in the environment's `env` option, or in the `env` of one `run()` or `spawn()` call, to override it.
