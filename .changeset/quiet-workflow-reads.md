---
"eve": patch
---

Retry transient Windows file-sharing errors when reading local workflow state while still surfacing persistent access errors and malformed state. Preserve pending tasks that fit the compaction budget and keep explicitly configured `mockModel()` responders during step-scoped dynamic model selection when authored-model mocking is enabled.
