---
"eve": patch
---

Make failed `eve init` runs recoverable: new targets are cleaned up, preexisting empty targets are restored, and existing projects receive the exact dependency-install command to retry.
