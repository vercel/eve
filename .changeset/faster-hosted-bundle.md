---
"eve": patch
---

Hosted builds no longer re-parse eve's largest output chunk while adding the Node ESM compatibility banner. This roughly halves the Nitro bundle step, and the repeated `MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME` warning no longer appears in build logs.
