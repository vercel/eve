---
"eve": patch
---

Keep channels defined with `routes: []` and a `receive` hook in the compiled agent, so schedules and other channels can hand off to them without a placeholder HTTP route.
