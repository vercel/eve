---
"eve": patch
---

`git({ github })` and the deprecated `code({ github })` register their authenticated `gh` tool at session start again, as do dynamic tools built with `defineGhTool` from `eve/extensions/git/sandbox`. Thanks @seahiLin for reporting this in #4986.
