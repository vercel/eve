---
"eve": patch
---

A sign-in that a new message cancelled is no longer asked for again in the same turn.

When a new message cancels an open sign-in, later calls in that turn that need the same grant fail with `reason: "sign_in_cancelled"` instead of posting another sign-in prompt, and the model is told to say the action needs that access. The next turn asks again.
