---
"eve": patch
---

Queue session stream writes instead of awaiting each one, so a turn's lifecycle events no longer serialize a durable stream round trip before the model call. Writes stay ordered, and the step joins them before it commits.
