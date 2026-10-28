---
"eve": minor
---

Rename `compaction.thresholdPercent` to `compaction.threshold`, which takes a 0–1 fraction.

The old key now fails with migration guidance. Set `limits.sessionUsage: false` to disable usage limits, including limits inherited from a parent agent.
