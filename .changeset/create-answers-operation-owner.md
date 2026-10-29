---
"eve": patch
---

Forward messages sent to the losing session of a create race to the running session.

When two `POST /eve/v1/session` requests create a session for the same `operationId` at once, they can get different session IDs, but only one session runs. Before, a message sent right away to the other session's ID was answered 202 and dropped. Now messages accepted by the other session are forwarded to the running session instead of being dropped. Creates that don't race are unchanged.
