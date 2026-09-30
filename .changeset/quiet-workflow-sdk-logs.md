---
"eve": patch
---

The `eve dev` terminal UI now hides Workflow SDK output such as `[workflow-sdk]` lines unless `/loglevel all` is on; the diagnostic log still records every line. eve also no longer warns with "Step execution already in flight in this process" when a queued step delivery loses a normal race with a new inline step.
