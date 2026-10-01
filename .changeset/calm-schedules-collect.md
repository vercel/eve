---
"eve": minor
---

Add experimental schedule collections with principal-scoped management, captured creator references, required code-defined deliveries (every schedule must name at least one, such as SMS, a Slack thread, or an S3 archive), generated tools, and a custom client. Schedule reads omit request content and updates change timing only; retained Workflow hooks preserve occurrence admission for seven days, including after session termination.
