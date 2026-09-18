---
"eve": patch
---

Reconcile frontend optimistic messages with their server delivery identities instead of stream order. Concurrent, coalesced, identical, and structured message submissions now resolve the correct placeholders, and separately delivered messages within one turn remain separate chat bubbles.
