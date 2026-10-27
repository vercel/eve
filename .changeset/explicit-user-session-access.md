---
"eve": minor
---

User-authenticated HTTP sessions now enforce creator ownership across messages, preparation, controls, and streams, while preserving same-user starter and development flows. Use `eveChannel({ authorizeSession })` for intentional sharing, other channels' sessions, or existing sessions without an ownership record; non-user transport access is unchanged.
