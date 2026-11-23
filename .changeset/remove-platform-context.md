---
"eve": patch
---

eve no longer looks up the platform of the process app from leaf code: telemetry and the development-environment checks read eve's built-in platform, and the remaining capabilities take the platform from their caller; behavior is unchanged.
