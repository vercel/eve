---
"eve": patch
---

`git({ github })` now registers `git__gh` at session start. Its callbacks captured the GitHub config getter, which eve cannot snapshot for replay, so the tool was dropped. The deprecated `code({ github })` `code__gh` tool, and dynamic tools built with `defineGhTool` from `eve/extensions/git/sandbox`, register again too.
