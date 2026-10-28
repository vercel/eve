---
"eve": minor
---

Remove the undocumented public exports `isDisabledToolSentinel`, `isDisabledRouteSentinel`, `isInstrumentationDisabled`, `answerFromText`, `failureOf`, and Linear's `defaultOnAgentSession`.

Use `failure(view, turnId)` from `eve/events` on a folded view, or check raw `turn.settled` and `session.ended` events for `outcome === "failed"`. Omit `onAgentSession` to keep Linear's default handler.
