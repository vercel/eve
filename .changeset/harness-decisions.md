---
"eve": patch
---

An experimental `agent/harness.ts` can now end a turn without the model, or fail it with its own message.

Its `next` runs before each model call as well as after one, and returns `{ settle }` or `{ fail }`; `ctx` shows the turn's `calls` and `steps`. The model's answers in a harness's turns are drafts (content phase `"draft"`) until the harness settles, so a rejected answer is never posted as the reply.
