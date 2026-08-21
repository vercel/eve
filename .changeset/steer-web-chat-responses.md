---
"eve": patch
---

Allow `useEveAgent` message sends with `turnPolicy: "steer"` while a turn is active, keeping the local projection attached to the durable replacement stream. Generated web chats now keep the composer enabled during responses and steer by default when a follow-up is submitted. Cancelled turns preserve their accepted user input in durable history, so replacement turns retain the interrupted request as context.
