---
"eve": minor
---

`eve/workflow` exports `getStepMetadata()`, which returns the current step's `stepId`, `attempt`, and `maxAttempts` inside a `"use step"` function, so a step can log retries, key idempotent side effects, and act on its last attempt.

Thanks @SiWarlock for requesting this in #5607.
