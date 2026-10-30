---
"eve": patch
---

A tool stub's `response` outcome can now set `endsTurn: true` to end the turn once a call gets that result, without another model call.

Evals can grade what an agent did up to a stubbed tool or agent call, such as which specialist it chose, without the model's next steps in the turn.
