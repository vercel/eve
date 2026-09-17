---
"eve": minor
---

Eval session ownership is now explicit: `t.session()` creates an empty session, and every `t.send()` creates a fresh session and returns a turn with `.session` for follow-ups. Replace `t.newSession()` with `await t.session()`, move conversation state and operations from `t` to the session handle, and read replies from `turn.message`.
