---
"eve": minor
---

A stream-event hook that throws no longer fails the turn or session. eve logs the failure with the hook and event identifiers, runs the remaining subscribers, and continues execution, including for `turn.started` and `step.started` hooks, which previously ended the turn with `EVENT_HANDLER_FAILED`.
