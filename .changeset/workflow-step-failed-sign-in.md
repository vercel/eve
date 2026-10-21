---
"eve": patch
---

A sign-in from a workflow step that fails with `retryable: false` now stops the rest of the turn from asking for it again, as it already did for ordinary tools. Workflow steps also stop starting a sign-in that failed that way earlier in the turn, and fail with that failure instead.

A call that completes one sign-in and then fails on another no longer marks the completed sign-in as failed terminally.
