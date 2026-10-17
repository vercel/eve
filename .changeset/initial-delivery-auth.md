---
"eve": patch
---

Preserve the authenticated session creator on the first message delivery. Initial tools and delegated work now run with the same caller identity as authenticated follow-up messages instead of losing it during admission.
