---
"eve": patch
---

Workflow tools in an `agents/<name>/` workspace member now compile with the workflow ID that the deployment registers, so calls no longer fail with "is not registered as a workflow in this deployment". Members can also import workflow and step modules from the shared root package, such as `lib/`.
