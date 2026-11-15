---
"eve": patch
---

Use the Workflow World’s default run-data retention when `experimental.workflow.retention` is omitted, independently of trace capture policy or conversation audience.

Set `experimental.workflow.retention: 0` explicitly to delete payloads and stream contents when a run ends. Existing explicit retention settings continue to apply.
