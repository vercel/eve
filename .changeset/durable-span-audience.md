---
"eve": patch
---

Reconstructed durable spans — `invoke_agent`, `agent.channel.delivery`, and `agent.approval` — now carry their channel audience on the parent context, so destination export policies see the real audience instead of `unknown` and apply the correct export and redaction decisions.
