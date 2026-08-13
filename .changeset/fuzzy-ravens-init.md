---
"eve": patch
---

Make failed `eve init` runs recoverable: new targets are cleaned up, preexisting fresh targets retain Git and environment metadata, and existing projects receive the exact dependency-install command to retry.
