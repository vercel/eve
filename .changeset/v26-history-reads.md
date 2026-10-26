---
"eve": patch
---

v27 deployments can read v26 session history through the v27 client and stream APIs. Convert previously saved legacy events with `convertLegacyEvents` from `eve/internal/legacy-events`, a temporary migration aid.
