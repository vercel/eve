---
"eve": patch
---

Connection authorization callbacks now honor the target session inbox wire version, preventing callback loss across mixed eve deployments and reporting unknown versions while the session stays parked.
