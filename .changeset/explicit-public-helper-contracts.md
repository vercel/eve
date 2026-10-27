---
"eve": minor
---

Remove undocumented public exports `isDisabledToolSentinel`, `isDisabledRouteSentinel`, `isInstrumentationDisabled`, `answerFromText`, `failureOf`, and Linear's `defaultOnAgentSession`. Use `failure(view, turnId)` from `eve/events` for projected failures and omit `onAgentSession` to keep Linear's default handler; retained event, channel, reporter, and extension helpers are now documented.
