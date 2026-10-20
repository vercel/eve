---
"eve": patch
---

Channel and session sends and responses now accept `idempotencyKey` to ignore retries across replay and owner handoffs. Photon supplies message IDs automatically; deduplication requires a shared Workflow World and only covers keys in the session's recent-key window.
