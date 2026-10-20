---
"eve": patch
---

Channel and session sends can supply an `idempotencyKey` to suppress retried deliveries across workflow replay and owner handoffs. Photon now supplies its message ID so redeliveries reaching another instance do not repeat agent input.
