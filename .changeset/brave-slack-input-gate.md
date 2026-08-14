---
"eve": patch
---

Authorize Slack HITL answers with `onInputResponse` before they resume a parked session. Omitting the hook preserves the existing submitting-user authorization behavior regardless of other Slack handlers.
