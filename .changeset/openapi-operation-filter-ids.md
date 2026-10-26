---
"eve": patch
---

OpenAPI `operations.allow` and `operations.block` now match an operation's `operationId` as written in the spec, as well as its generated tool name. Before, an `operationId` with characters such as `.` or `/` never matched, because eve compared the filter only against the sanitized tool name, so a blocked operation stayed callable.
