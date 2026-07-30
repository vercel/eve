---
"eve": patch
---

Upgrade the vendored Workflow DevKit to `@workflow/core@5.0.0-beta.38`. This picks up the upstream fix for runs going dormant after an accepted hook resume (vercel/workflow#3183): a session cancelled while parked on subagents could previously hold the accepted cancel indefinitely — its turn only settling as cancelled when unrelated traffic happened to wake the run. beta.38 also restored runtime world selection in core's `createWorld()`, which statically imports both first-party worlds; eve stubs those imports at vendor time so hosted Vercel bundles keep excluding local-world infrastructure.
