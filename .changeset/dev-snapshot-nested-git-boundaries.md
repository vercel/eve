---
"eve": patch
---

Stop `eve dev` source snapshots from recursing into nested git repositories or worktrees, avoiding duplicate checkout copies under directories such as `.claude/worktrees`.
