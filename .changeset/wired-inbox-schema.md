---
"eve": patch
---

Session inbox hook payloads are now a validated, versioned wire format following eve's existing durable-format idioms. Producers inspect the target hook's wire capability and encode the shape its pinned consumer understands, including sessions created by eve 0.30.8; readers migrate legacy shapes forward and reject unknown versions instead of reinterpreting them.
