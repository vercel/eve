---
"eve": patch
---

`subagent.called` and `subagent.completed` hooks can now call `ctx.getSandbox()` for the parent session, and sandbox changes they make are kept for the parent's next turn.
