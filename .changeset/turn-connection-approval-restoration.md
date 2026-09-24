---
"eve": patch
---

Restore turn-scoped dynamic connections before authorizing approval responses, including after a cold start. Connection response policies now run instead of failing because their callbacks are unavailable, while preserving policy rejection reasons.
