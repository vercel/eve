---
"eve": patch
---

Fix a local workflow health-check failure after model or source changes. Capability probes no longer look up a run before it exists, avoiding a spurious queue error and startup delay.
