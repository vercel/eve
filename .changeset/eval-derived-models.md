---
"eve": patch
---

Eval results now list the models their steps started with: `derived.models` on each session holds the distinct model ids in first-use order, and the eval result's `derived.models` merges them in session order. Only the sessions an eval created or attached are covered.
