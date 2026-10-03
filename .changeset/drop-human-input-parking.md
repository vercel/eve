---
"eve": patch
---

Human-in-the-loop is being rebuilt behind one module. Until each case returns, a turn that needs a person fails with `HUMAN_INPUT_UNAVAILABLE` instead of waiting: tool approvals, tool sign-ins, the session budget question, and questions a child session or workflow `ctx.ask()` relays. Sessions that cannot ask a person still fail with `SESSION_TOKEN_LIMIT_REACHED` or the token-cost limit code when they reach their budget.
