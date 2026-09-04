---
"eve": patch
---

Serialize concurrent Workflow replays for each agent run on Vercel while continuing to run steps in parallel. This avoids replay contention when a task has multiple pending hooks or wakes.
