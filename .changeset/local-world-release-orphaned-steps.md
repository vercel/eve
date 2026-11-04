---
"eve": patch
---

Fix local-world sessions that stalled after `eve start` or `eve dev --resume` restarted mid-turn: a turn waiting on a timer, such as `sleep`, now wakes on time, and a step that was running when the previous process stopped runs again right away instead of after about 14 minutes.

The timer fix applies to spec 9 runs, which eve now creates by default. The step fix applies to spec 8 runs, including every session created before eve moved to spec 9. For those runs, the interrupted attempt counts toward the step's retries, so a workflow tool step with `maxRetries: 0` that was running when the process stopped fails on restart instead of running again. Run one process per `.eve/.workflow-data` directory: recovery treats steps started before it booted as abandoned.
