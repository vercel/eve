---
"eve": patch
---

Model calls made by `decide()` from `eve/ai`, and so by `auto()` and approval `auto()`, now count toward the session's usage and `limits.sessionUsage`. `recordUsage(usage)` from `eve/ai` does the same for an AI SDK call you make yourself in a tool, a dynamic value, a hook, or a harness; inside a tool it's recorded against the call.
