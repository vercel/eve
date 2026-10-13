---
"eve": minor
---

Instrumentation providers now hear the session's own event names, with each ending carrying its outcome: `session.ended`, `turn.settled`, `call.requested` and `call.settled`, and `interaction.opened` and `interaction.settled` replace `session.completed`/`failed`, `turn.completed`/`cancelled`/`failed`, `tool.call.*`, and `input.requested`/`resolved`; `session.waiting` is removed, since waiting is read from the session's state. OpenTelemetry span names and trace schema 4 don't change; the Braintrust integration needs a release that reads the new names.
