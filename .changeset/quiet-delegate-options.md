---
"eve": patch
---

Allow local subagents to opt into per-call model, reasoning and cost selection with `delegationModels`. Fresh calls can supply `execution`; existing children retain their configuration and requested cost ceilings cannot raise inherited quotas.
