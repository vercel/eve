---
"eve": patch
---

The package now ships recorded session streams for delegated calls under `eve/conformance/task-streams/v1/` (a `manifest.json` and one NDJSON file per scenario), so stream consumers can replay real `task.*` traffic in their own contract tests; the new Tasks docs page describes them. Eval facts record agent calls from `task.started` and `task.settled`: a call stays `working` until its `task.settled`, whichever of its receipt and `task.started` arrives first, and a call that fails before its child starts is recorded from its `task.settled`.
