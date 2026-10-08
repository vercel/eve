---
"eve": patch
---

A typed reply now answers a tool approval or session-limit prompt proxied from a subagent, the same way it answers a subagent's `ctx.ask()` question. On text-only channels such as Linq, Twilio, and Linear, replying `approve` or `continue` resumes the subagent instead of reaching the parent model while the subagent stays parked. When a subagent raises several prompts at once, each reply answers the first open one.
