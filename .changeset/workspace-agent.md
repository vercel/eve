---
"eve": patch
---

Add `defineWorkspaceAgent()` for delegating to one explicitly addressed workspace peer. It selects Vercel routing and OIDC automatically on Vercel, accepts explicit transport overrides elsewhere, and uses the peer agent's description by default.
