---
"eve": patch
---

Fix dynamic connection tools so approval gates from OpenAPI and other connection-backed tools are preserved when the tools are exposed to the model. Calls to connections with `approval: always()` now correctly park for HITL approval before execution.
