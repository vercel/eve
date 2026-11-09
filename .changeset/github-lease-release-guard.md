---
"eve": patch
---

A `gh` command whose credential lease was taken over as stale no longer clears the next command's credential when it releases. Each wait for the lease is recorded as an `agent.github.lease.wait` span, with `agent.github.lease.outcome`, `agent.github.lease.attempts` and `agent.github.lease.waited`.
