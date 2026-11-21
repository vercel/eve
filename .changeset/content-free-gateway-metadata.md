---
"eve": patch
---

Keep the AI Gateway's cost, generation id, and routing on `model.call.settled` instrumentation events and model call spans when the trace policy doesn't record content.

The AI SDK now drops `providerMetadata` from telemetry events when inputs or outputs aren't recorded, so eve reads it from its own model call callback instead. The content-free reduction also keeps the gateway's `marketCost` and `routing.finalProvider`.

Thanks @zackleman for reporting this in #6537.
