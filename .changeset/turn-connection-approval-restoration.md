---
"eve": patch
---

Restore turn-scoped dynamic connections before authorizing approval responses, including after a cold start. Connection response policies now run instead of failing because their callbacks are unavailable; missing tools or changed connection identities fail explicitly rather than replaying against a replacement connection.
