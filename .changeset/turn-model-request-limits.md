---
"eve": patch
---

Agents can bound a single turn with `limits.maxModelRequestsPerTurn` and `limits.turnTimeoutMs`. eve charges every model request it sends for the turn, including its own retries and automatic compaction, before sending it, and aborts a request in flight when the turn deadline passes. Reaching either limit fails the turn with `TURN_LIMIT_REACHED` and leaves the session waiting for the next message.
