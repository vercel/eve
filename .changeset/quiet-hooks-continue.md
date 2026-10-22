---
"eve": patch
---

Update the bundled Workflow runtime to reduce redundant history reads during concurrent hook registration and avoid unnecessary input/output reads when resuming hooks. Include replay-ordering fixes and the local-world fix for deliveries that race a session handoff.
