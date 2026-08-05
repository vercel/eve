---
"eve": patch
---

Trace spans now record what eve dispatched each action as. `agent.action.kind` was always `"tool"`, so a subagent or remote-agent call was indistinguishable from an ordinary tool in a trace; it now reports `subagent-call`, `remote-agent-call`, or `tool-call`, matching the kind on the corresponding `actions.requested` event.
