---
"eve": patch
---

Fix human-in-the-loop approval resume behavior so text replies like `approve` resolve pending tool approvals and unrelated follow-up messages no longer synthesize a denial. Rejected approval results now include explicit approval and not-run metadata for clients.
