---
"eve": patch
---

A cancelled sign-in is no longer asked for again in the same turn, and a scheduled run never asks for a sign-in.

When a new message cancels an open sign-in, later calls in that turn that need the same grant fail with `reason: "sign_in_cancelled"` instead of posting another sign-in prompt. A turn a schedule started, including a scheduled send into an existing conversation, fails calls that need a sign-in with `reason: "sign_in_unavailable"`. In both cases the model is told to say the action needs that access. A later message from the person asks again.
