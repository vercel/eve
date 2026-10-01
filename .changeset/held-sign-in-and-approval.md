---
"eve": minor
---

A connection sign-in or tool approval now holds the turn open, like a question or task: the stream emits `turn.waiting` instead of `turn.completed` and `session.waiting`, and the same turn resumes once the person acts. Every `turn.waiting` now carries `on`: `"input"` when a person must act, `"tasks"` when the turn waits on its own work. A message from that person steers the turn and cancels the pending sign-in or approval, messages from anyone else wait for the turn to end, and cancelling the turn withdraws both, so an approval no longer stays answerable after a cancel. Slack's sign-in prompt gains a Cancel button.
