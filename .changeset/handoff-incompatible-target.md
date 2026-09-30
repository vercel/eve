---
"eve": patch
---

When a target deployment cannot read the session checkpoint version, validation returns incompatibility instead of throwing so Workflow no longer retries the step. The turn is processed on the current owner immediately.

Owners running this eve build remember every deployment that reported incompatibility and skip handoff to those targets for later turns in the same run. Sessions whose owner workflow started on an older build still attempt handoff each turn, but each attempt no longer triggers validation retries on the target.
