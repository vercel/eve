---
"eve": patch
---

Fixed an intermittent build failure when two deployments build the same app at the same time. Builds now wait for the in-progress sandbox snapshot to finish instead of failing.
