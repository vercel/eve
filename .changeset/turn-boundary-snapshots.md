---
"eve": patch
---

Read session snapshots once at turn admission and write them once at settlement, carrying intermediate state in Workflow step inputs and results. Interrupted steps now use normal Workflow retries instead of failing on extra in-progress snapshot markers.
