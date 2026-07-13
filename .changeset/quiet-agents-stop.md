---
"eve": minor
---

Make the built-in `agent` tool root-only, so copies created by it cannot delegate recursively. Declared subagents can still call their own nested subagents, and `limits.maxSubagentDepth` has been removed.
