---
"eve": minor
---

Input requests now include a required `kind` discriminator so clients can route tool approvals, questions, and session-limit decisions without inferring behavior from tool names or request IDs. Descendant session-limit Stop responses now let the parent own turn cancellation, avoiding a parent-child wait cycle.
