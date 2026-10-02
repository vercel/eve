---
"eve": patch
---

Long-lived sessions now move to newer deployments after an eve upgrade: a deployment upgrades handoff checkpoints written by eve 0.66.0 and later instead of leaving the session on its old deployment, and stops idle subagent sessions those releases kept for reuse. Refused handoffs now log why on both deployments. Callbacks from remote agents to sessions created by eve 0.66–0.68 no longer fail with `Unsupported callback kind`.
