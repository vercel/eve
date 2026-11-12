---
"eve": patch
---

Steering no longer discards a model call that is streaming a tool call's input, so the model doesn't write a long input twice.

The call finishes, the tool runs, and the new message applies at the next step boundary in the same turn.

Thanks @zackleman for reporting this and proposing the fix in #5929.
