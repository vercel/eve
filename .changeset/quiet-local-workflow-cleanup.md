---
"eve": patch
---

`eve dev` now cancels unfinished local Workflow runs whose development snapshots are gone, instead of repeatedly reporting them as startup errors. Runs with retained snapshots still recover across restarts, and cancelled runs record why they can no longer resume.
