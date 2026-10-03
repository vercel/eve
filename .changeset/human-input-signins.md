---
"eve": patch
---

Tool sign-ins and approval response policies work again. A tool call that needs a sign-in holds its turn until the callback arrives, then the model calls it again as the person who started it. An answer to an approval with an `approval.response` policy becomes a candidate that settles the approval once the policy allows it, including after the responder signs in.
