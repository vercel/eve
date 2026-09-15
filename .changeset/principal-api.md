---
"eve": patch
---

Add `credentialOwner` for raw connection auth and `caller` for audience callbacks while preserving existing `principalType` APIs. Classify anonymous eve channel sessions as `unknown` by default and fix token cache keys so user identifiers containing separators or percent sequences cannot collide.
