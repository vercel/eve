---
"eve": patch
---

Throw a clear, non-retrying error when a `defineState()` handle is read or updated inside a workflow tool's `"use step"` function.

A step runs outside the session that owns the state, so `get()` silently returned `initial()` and `update()` silently discarded its write. Code that relied on that now fails the step without a retry. Return the value from the workflow tool and update state in a `call.settled` hook instead; see the [State](https://eve.dev/docs/concepts/state#update-state-from-a-workflow-tool) docs.
