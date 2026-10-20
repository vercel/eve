---
"eve": patch
---

Channel and session sends can supply an `idempotencyKey` to suppress retried deliveries across workflow replay and owner handoffs. Photon now supplies its message ID so replicas sharing a Workflow World do not repeat agent input while that ID remains in the session's recent-key window.
