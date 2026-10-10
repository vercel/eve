---
"eve": patch
---

Report `turn.paused` when a model step parks on blocking workflow execute calls, including calls dispatched after approval: its `awaiting` names each call the turn waits on (`{ callId }`). Task and agent receipt dispatches do not pause the turn on their own; their actual task waits report the pause.
