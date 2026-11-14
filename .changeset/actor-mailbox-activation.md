---
"eve": patch
---

eve has an internal actor layer on a Workflow World: each actor is a run with a journal, a stream, a mailbox and aliases, written by one process at a time, activated on the World's queue by a message or an alarm, and ended to free its aliases.

A message sent while an activation runs reaches it promptly through a hint on a stream the activation follows live, and a wake for messages an activation already took activates nothing. Mailbox messages and kept values are sealed at rest like the rest of an actor's bodies, and a World in this process can have a queue for tests and scripts.
