---
"eve": minor
---

Session commands now return `Delivery` receipts with independent `stream()` and `result()` reads; the eve HTTP message route accepts `idempotencyKey` for retries within a session's recent-key window. Session creation returns `{ session, delivery }` when a message is supplied and `{ session }` otherwise; import shared contracts from `eve/sessions`.
