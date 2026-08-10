---
"eve": patch
---

Session inbox hook payloads are now a validated, versioned wire format following eve's existing durable-format idioms: every persisted inbox payload (sends and controls) carries a `version` and is validated against the version's declared field table on both encode and decode, legacy shapes migrate forward on read, and payloads with an unknown version or malformed shape are dropped with an operator-visible error instead of being reinterpreted — the session stays alive. Session inbox hooks are also stamped with the consumer's eve version so future wire changes can be version-gated per consumer.
