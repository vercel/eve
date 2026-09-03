---
"eve": patch
---

Prevent approving one tool call from auto-authorizing other already-pending calls with the same approval key. Existing approval prompts now remain independent, while `once()` still auto-allows calls proposed after the pending requests are resolved.
