---
"eve": patch
---

eve now owns the full OpenTelemetry lifecycle it registers: declared metric readers are flushed on `forceFlush` and shut down on `shutdown`, and declared auto-instrumentations are disabled at shutdown, so metrics recorded near teardown are exported instead of silently dropped.
