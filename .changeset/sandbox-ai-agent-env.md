---
"eve": patch
---

Sandbox commands now run with `AI_AGENT=eve` by default, so agent-aware CLIs such as `vercel` switch to their non-interactive agent mode. Pass `env.AI_AGENT` to `run()` or `spawn()` to override it; the default takes precedence over an `AI_AGENT` set in an environment's `env` option.
