---
"eve": patch
---

`send()` now ends at the boundary that completes its own delivery, and `EveAgentStore` follows a steered message until a boundary lists it, so a message steered into a running turn no longer ends at that turn's earlier boundary.
