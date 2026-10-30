---
"eve": patch
---

An experimental `agent/harness.ts` can now call tools itself, with `next` returning `{ calls }`.

Each call goes through the same approvals and sign-ins as the model's, and the turn's history records it as a call the agent made.
