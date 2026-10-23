---
"eve": patch
---

Fix the `git__gh` tool from `eve/extensions/git`, and the deprecated `code__gh` from `code({ github })`, never appearing when `github` is configured. Their session-start resolvers returned a tool whose `execute` captured the config getter, which eve can't persist for a dynamic tool, so eve rejected the tool at session start.
