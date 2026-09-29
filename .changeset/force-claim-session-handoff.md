---
"eve": patch
---

Deployment handoffs no longer leave a session briefly unowned: the new owner takes over every session hook in place, so channel deliveries during a handoff reach a live owner without waiting and retrying. Sessions whose previous owner ran eve 0.66.2 or earlier, and sessions on a Workflow World without forced hook claims or hook retention, still hand off the old way. Sessions no longer move to a deployment running eve 0.67.1 or earlier, such as after a rollback.
