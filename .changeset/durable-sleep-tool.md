---
"eve": patch
---

Add an opt-in durable `sleep` tool from `eve/tools/sleep`. Agents can export `sleep()` from `agent/tools/sleep.ts` to let the model pause a turn before checking progress or status again without holding an application runtime open.
