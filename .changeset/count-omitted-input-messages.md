---
"eve": patch
---

Record `agent.input.messages.omitted` on model spans when the oldest prompt messages are dropped to fit the 32 KB content cap, so a long conversation no longer looks like it starts partway through.
