---
"eve": patch
---

Coalesce consecutive streamed text, reasoning and tool-input deltas over a 100 ms window even when the stream writer acknowledges immediately, reducing durable history event counts. The first delta of each stream, boundary events and close continue to flush without the batching delay.
