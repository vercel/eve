---
"eve": patch
---

Fix `eve dev` requests that use a sandbox failing with `ENOENT … sandbox-preparation.lock` when another request finished preparing sandboxes at the same time.

These requests now wait for the other request and continue, as they already did while preparation was in progress.
