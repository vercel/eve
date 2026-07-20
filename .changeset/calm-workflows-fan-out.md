---
"eve": patch
---

Workflow now keeps sandbox bridge capacity aligned with its configured `maxSubagents` budget, so large `Promise.all` fan-outs park and dispatch child sessions instead of failing at code mode's lower internal concurrency limit.
