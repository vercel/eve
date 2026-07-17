---
"eve": patch
---

Every eve-owned tool input is now validated against its schema before execution, so invalid calls are returned to the model for retry instead of failing the run. Subagent calls treat an empty `outputSchema` as absent, and OpenAPI operations with invalid schemas are omitted with a warning.
