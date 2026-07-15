---
"eve": patch
---

Fix the dev-only schedule dispatch route to load compiled artifacts from the active development generation instead of the authored app root, which returned a 500 for every dispatch.
