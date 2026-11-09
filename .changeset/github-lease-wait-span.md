---
"eve": patch
---

Each wait for a `gh` command's sandbox credential lock is recorded as an `agent.github.lease.wait` span, with `agent.github.lease.outcome`, `agent.github.lease.attempts` and `agent.github.lease.waited`.
