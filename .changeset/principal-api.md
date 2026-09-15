---
"eve": patch
---

Classify anonymous eve channel sessions as `unknown` by default, so their content is not recorded in preview or production traces unless you mark the audience public explicitly. Also add `credentialOwner` for raw getToken-only auth and `caller` for audience callbacks while preserving existing `principalType` APIs, and fix token cache keys so user identifiers containing separators or percent sequences cannot collide.
