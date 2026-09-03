---
"eve": patch
---

Give each delegated local or remote agent session its own replay-stable OpenTelemetry trace. Parent caller spans record acknowledged child trace IDs, and child session roots link back to the exact parent dispatch span.
