---
"eve": minor
---

Prevent channel HITL responses from carrying channel-local metadata into strict session-inbox payloads. Channel and session `respond()` calls now accept exact response literals or values proven by `parseInputResponses()`, rejecting imprecise `InputResponse[]` values that could have erased extra keys.
