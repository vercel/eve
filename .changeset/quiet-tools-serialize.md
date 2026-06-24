---
"eve": patch
---

Validate default tool model output before adding it to conversation history, so non-JSON values such as `Date` fail with a serialization error instead of a later invalid-prompt error.
