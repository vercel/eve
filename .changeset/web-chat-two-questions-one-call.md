---
"eve": patch
---

The Web Chat template now shows every question a tool call asks at once. Before, when a workflow called `ctx.ask` twice in parallel, the second question replaced the first, so the first question couldn't be answered and the tool stayed blocked.
