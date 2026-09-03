---
"eve": minor
---

Emit one bounded OpenTelemetry trace per agent activation, continuing an awaited child activation from its exact caller context while resumed turns start fresh traces. eve now omits synthetic session spans and stamps owned spans with the current workflow run in `vercel.session_id` and the root workflow run in `gen_ai.conversation.id`.
