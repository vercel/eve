---
"eve": minor
---

Rename `reset()` to `end()` on client sessions, frontend stores/hooks, and channel/Slack handles, `ResetSessionResult` to `EndSessionResult`, and the HTTP retirement endpoint to `POST /eve/v1/session/:sessionId/end`.

Ending keeps the retired ID: use `newSession()` or `client.sessions.create()` for a fresh conversation, or `clear()` to clear context in place; remote-agent and session-history compatibility encodings remain unchanged.
