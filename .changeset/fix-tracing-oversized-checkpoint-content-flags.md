---
"@vercel/agent-runs": patch
---

Keep oversized checkpoints honest by preserving the real `agent.trace.content.input`/`output` capture flags and keeping the turn's copied input/output as a truncated copy (or omitting it) instead of rewriting the flags to `false` when a turn node exceeds the checkpoint size budget.
