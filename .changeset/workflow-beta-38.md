---
"eve": patch
---

Upgrade the vendored Workflow DevKit to `@workflow/core@5.0.0-beta.38`. This picks up the upstream fix for runs going dormant after an accepted hook resume (vercel/workflow#3183): a session cancelled while parked on subagents could previously hold the accepted cancel indefinitely — its turn only settling as cancelled when unrelated traffic happened to wake the run.
