---
"eve": patch
---

A `ctx.agent` turn that fails now reports why: `result()` returns `error.message` alongside `status: "failed"`. Agent tasks and `workflow` program calls include that reason in their failure, so the parent sees the agent's error instead of "The agent's session ended."
