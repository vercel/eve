---
"eve": patch
---

Channel route handlers now receive `invokeTool(name, input, { auth })`, which runs one of the agent's tools as the given caller outside any conversation, with a sandbox that lasts for the call. Tools whose approval policy asks a person resolve to `approval-required` without running.
