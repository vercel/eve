---
"eve": minor
---

When a deploy moves a session to a new deployment, eve now retires the session's idle subagents and `serve` tool tasks, so the model's next call starts them fresh on the current build instead of continuing them on the old one.

Before, an idle resumable task kept running the build that started it for as long as its parent session lived, so a fix shipped to a subagent never reached the sessions already using it. A retired task's old run is told to end; a result the model hasn't read is still delivered, and spend the run reports as it stops still counts. The next call starts without the old task's conversation or `serve` state, and a call by the old `taskId` fails with `UNKNOWN_TASK`. A compaction handoff stays on the same deployment and keeps its idle tasks.

Thanks @zackleman for proposing this in #5926.
