---
"eve": minor
---

Background workflow tools now execute as their task's durable workflow run, subagents can be invoked directly from waiting workflow tools and workflow sandboxes, and workflow `agent()` calls require a replay-stable `key`. Tool calls interrupted by a provider content filter now settle as failed results so later turns remain usable.
