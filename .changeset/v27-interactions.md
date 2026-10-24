---
"eve": minor
---

Approvals, questions, sign-ins, and budget prompts now share the `Interaction` model, with answers shaped as `{ interactionId, optionId?, text? }` and approval choices `approve` / `deny`. Turns pause only for human input; cancelling an agent task retires it, and `eve invoke` reports `input-required` when a person must respond.
