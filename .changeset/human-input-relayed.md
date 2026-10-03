---
"eve": patch
---

Questions and approvals that child sessions, remote agents, workflow `ctx.ask()`, and the `ask_question` tool relay through a session work again instead of failing with `HUMAN_INPUT_UNAVAILABLE`. The session asks at the child's coordinates and holds the turn on the call that asked. It forwards each answer to whoever asked, and a typed reply answers the only relayed question waiting. When a run ends, is cancelled, or withdraws its question, the session withdraws what that run asked. A relayed budget Stop cancels the parent turn too. Relayed sign-ins still need the sign-in rebuild.
