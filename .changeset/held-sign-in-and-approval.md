---
"eve": minor
---

A connection sign-in or tool approval now holds the turn open, like a question or task: the stream emits `turn.waiting` with `awaitingPerson: true` instead of `turn.completed` and `session.waiting`, and the same turn resumes once the person acts. A message from that person steers the turn and cancels the pending sign-in or approval, messages from anyone else wait for the turn to end, and Slack's sign-in prompt gains a Cancel button.
