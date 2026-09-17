---
"eve": patch
---

Use the AI Gateway connection selected through `/login` for string evaluation models during `eve dev`, so `autoModel` works without a separate environment credential.

Correct the default evaluator to `typesafe-ai/jev` and stop showing a missing-connection warning for dynamic model selectors before they resolve.
