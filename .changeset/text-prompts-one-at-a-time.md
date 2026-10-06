---
"eve": patch
---

When a turn waits on several questions or approvals, a typed reply now answers the first open one instead of none, so people can answer them one message at a time. Twilio, GitHub, Linear, and Chat SDK channels (including Linq and Photon) show one prompt at a time and post the next once it is answered. An approval raised alongside a workflow tool call such as `ask_question` is now requested after that call finishes, since it can't take effect before then.

On Twilio, GitHub, and Linear, the built-in prompt queue spans the `input.requested`, `input.resolved`, and `approval.settled` handlers. If you override any one of them, override all three, or the built-in handlers will post prompts twice or stop posting later ones. If you render prompts yourself from `input.requested`, make `input.resolved` and `approval.settled` no-ops.
