---
"eve": patch
---

Cancelling a turn no longer records the tools and model calls it stops as `AbortError` exceptions in traces.

The step running the turn now sees the cancellation as `TurnCancelledError`, even when the Workflow step boundary drops the abort's reason, so tools and model calls it stops end their spans as cancelled instead of recording an exception.
