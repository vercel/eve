---
"eve": minor
---

Restrict the built-in recursive `agent` tool to the root session while keeping explicitly declared subagent chains available at any depth. Recursive children and declared subagents no longer receive the built-in self-delegation tool, and the obsolete `limits.maxSubagentDepth` option has been removed.
