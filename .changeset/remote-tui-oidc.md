---
"eve": patch
---

Remote `eve dev --url` sessions now show deployment and authentication state, try refreshed project-scoped OIDC credentials at startup, and open a cancellable `/vc:login` recovery flow when access is rejected. The flow can update the target project's Trusted Sources after confirmation.
