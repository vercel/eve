---
"eve": patch
---

eve now records which of its catalog tools a session has been offered in the same session state as its other definitions, rather than under a separate context key.

A session an earlier deployment ran still keeps every catalog tool it was offered. After a rollback to an earlier deployment, a catalog tool the session was offered only under the newer one leaves the tool list until something the agent offers reaches it again; calls already waiting on approval still run.
