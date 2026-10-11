---
"eve": patch
---

Agents that use `mockModel` from `eve/evals` now compile without `modelContextWindowTokens`. Before, the documented one-line `mockModel` example failed with a missing AI Gateway context window error; mock models now default to a 1,000,000-token window.
