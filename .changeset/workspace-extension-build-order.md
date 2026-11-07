---
"eve": patch
---

`eve build`, `eve dev`, and `eve eval` now build a workspace extension after the workspace extensions it depends on, so an extension whose subagent mounts another workspace extension builds from a clean checkout.

Thanks @dretanacr for reporting this in #5837 and for the implementation plan.
