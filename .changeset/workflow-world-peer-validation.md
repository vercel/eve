---
"eve": patch
---

Validate custom `experimental.workflow.world` packages during build. eve now rejects world packages whose `@workflow/world` dependency metadata is not compatible with the Workflow world version bundled by eve, so incompatible adapters fail before runtime startup.
