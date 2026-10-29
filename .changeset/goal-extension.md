---
"eve": patch
---

Add `eve/extensions/goal`, a built-in extension that gives a session a durable goal.

After every turn a judge decides whether the goal is met; if not, the extension continues with hook `ctx.continue()` until the goal is met, judged impossible, paused, or out of budget. Pass `setApproval` to require approval before the model sets a goal.
