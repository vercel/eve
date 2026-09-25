---
"eve": patch
---

Deployment handoffs no longer leave a session briefly unowned: the new owner takes over every session hook in place, so channel deliveries during a handoff reach a live owner without waiting and retrying. Sessions whose previous owner ran eve 0.66.2 or earlier still hand off the old way, and sessions no longer move to a deployment running eve 0.66.3 or earlier, such as after a rollback.
