---
"eve": patch
---

Background workflow tasks now deduplicate redelivered reports by producer-assigned identity, preventing a retried progress message from waking the parent twice. Separate reports with identical text are still delivered separately.
