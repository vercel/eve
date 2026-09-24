---
"eve": patch
---

The package now ships recorded session streams for delegated calls under `eve/conformance/task-streams/v1/` (a `manifest.json` and one NDJSON file per scenario), so stream consumers can replay real `task.*` traffic in their own contract tests; the new Tasks docs page describes them. Eval facts now keep a background agent call `working` until its `task.settled` even when the child's `task.started` arrives before the receipt, and record a background agent call that fails before its child starts.
