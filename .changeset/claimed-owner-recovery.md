---
"eve": patch
---

Resolve retried workflow-tool and background-task starts from their claimed inbox rather than waiting for an owner stream that the original start may not have written. Preserve cancelled child handles so later turns can list and resume those children.
