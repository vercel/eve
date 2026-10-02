---
"eve": patch
---

Cancelling a turn, clearing the context, a sign-in, or a task or workflow run ending now reports everything it closes: each request it withdraws settles `cancelled` in `input.resolved`, each sign-in it withdraws reports `declined`, and each call it stops reports `action.result` status `cancelled` with the reason in `error.code`. `session.waiting` and `turn.waiting` also list the deliveries they complete in `processedDeliveryIds`, and a policy's automatic denial reports `rejected`, like a person's.
