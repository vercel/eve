---
"eve": patch
---

Fix `eve dev` streaming throughput and time-to-first-token degrading as parked (`ask_question` / HITL) sessions accumulate. The dev runtime's NDJSON event-stream reader now forwards cancellation to the underlying run stream, so disconnecting from a parked session no longer leaks a filesystem polling loop for the life of the dev server.
