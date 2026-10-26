---
"eve": patch
---

Harden the remote agent wire before protocol 3 ships. Every callback URL names the protocol its parent and child agreed, and a parent run from before v27 receives an earlier child's approvals, questions, and sign-ins as before. Follow-ups and answers to a protocol-3 child carry an idempotency key, so a retry after a lost response is the same delivery with the same receipt; the eve channel's message route accepts `idempotencyKey`. A child whose result finds nothing waiting, such as after a lost acknowledgement, keeps its session instead of failing it.
