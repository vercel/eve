---
"eve": minor
---

Add experimental run streams: `getWritable({ namespace })` from `eve/experimental/workflow`, and `getReadable(runId, { namespace, startIndex })` and `getHookRunId(token)` from `eve/experimental/workflow/api`.

A long-running workflow can publish its state to a named stream on its run, and a route or step that knows the run ID can read it, for example the latest chunk with `startIndex: -1`. `getHookRunId` resolves the run that holds a hook token, or `null`, so other tools can find a run without storing its ID. A namespace is required and can't start with `eve.` or `eve:`, because a run's default stream and those namespaces belong to eve. Like the rest of the experimental entries, these have no compatibility promise.
