---
"eve": patch
---

An optimistic message no longer stays in the `submitted` state when its turn is cancelled or fails before the agent reads it. `EveAgentStore` now marks that message `failed`, so it keeps its own text, and later messages reconcile against their own submissions. A steered message the cancelled turn never read now also lets its `send()` settle. Thanks @brettcrane for reporting this in #3102.
