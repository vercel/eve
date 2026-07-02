---
"eve": patch
---

`eve dev` now prunes terminal workflow runs older than 24 hours from the local workflow store (`.workflow-data`) in the background at boot, together with their linked events, steps, hooks, and stream files. Runs in any non-terminal status are never removed, so parked HITL runs stay resumable. This keeps the local queue's per-operation directory scans — and the dev server's CPU cost under sustained workflow traffic — bounded by recent activity instead of lifetime history.
