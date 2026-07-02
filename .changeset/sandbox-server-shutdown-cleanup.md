---
"eve": minor
---

Sandboxes are now stopped when the eve server shuts down. Self-hosted production servers stop every open sandbox (microsandbox VMs, Docker containers, Vercel sandboxes, just-bash interpreters) on `SIGTERM`/`SIGINT`, matching the cleanup `eve dev` already performs, and sessions reattach from persisted state on the next start. Breaking change for custom sandbox backends: `SandboxBackendHandle` gains a required `shutdown()` and the unused `dispose()` is removed.
