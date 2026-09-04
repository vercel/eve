---
"eve": patch
---

Inline turns now handle workflow tools on the parent through one ordered inbox for progress, input requests, and outcomes. Waiting workflow tools use a fresh cancellation token per dispatch attempt; a retried dispatch can start another run, so side effects need application idempotency.
