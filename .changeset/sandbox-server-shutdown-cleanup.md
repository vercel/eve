---
"eve": minor
---

Sandboxes are now stopped when the eve server shuts down. Self-hosted production servers stop every open sandbox (microsandbox VMs, Docker containers, Vercel sandboxes, just-bash interpreters) on `SIGTERM`/`SIGINT`, matching the cleanup `eve dev` already performs, and sessions reattach from persisted state on the next start. Custom sandbox backends must now implement `shutdown()` on the handle returned from `create` (breaking change to `SandboxBackendHandle`).
