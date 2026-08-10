---
"eve": patch
---

Conversation-mode turns that park on connection authorization now emit `turn.completed` and `session.waiting` (with the continuation token) before parking — chat clients render the connect card and settle the turn instead of hanging on "Thinking…". Channel/task sessions are unchanged.
