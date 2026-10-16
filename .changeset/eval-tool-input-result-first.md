---
"eve": patch
---

Keep a tool call's input and a skill load's output in eval facts when the stream delivers the result before its request, so `t.calledTool(name, { input })` and `t.loadedSkill(name, { status })` no longer miss the call.
