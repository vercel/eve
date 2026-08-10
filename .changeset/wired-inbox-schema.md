---
"eve": patch
---

Session inbox hook payloads are now a validated, versioned wire format following eve's existing durable-format idioms: one schema owns the complete transported value, every writer validates before persistence, legacy shapes migrate forward on read, and consumers reject unknown versions instead of reinterpreting them. Session inbox hooks are also stamped with the consumer's eve version so future wire changes can be version-gated per consumer.
