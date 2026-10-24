---
"eve": minor
---

Session commands now return `Delivery` receipts with independent `stream()` and `result()` reads; duplicate keyed sends settle as `ignored` without repeating the original work or reply. Session creation returns `{ session, delivery }` when a message is supplied and `{ session }` otherwise; import shared contracts from `eve/sessions`.
