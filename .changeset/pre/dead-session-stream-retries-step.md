---
"eve": patch
---

When a session stream write fails, the turn step now stops writing and fails at once, so Workflow retries it with a fresh stream, instead of retrying the model call, steering, or reporting a model call failure to the stream that just failed.

Previously, eve read a failed write as a model call error: it retried the provider request, logged that it was "parking session for retry by the user", and tried to write a failure that could never arrive. The retried step closes the model attempt the write cut as `abandoned`, as it does for any interrupted step.

Thanks @zackleman for reporting this in #5917.
