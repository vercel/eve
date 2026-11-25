---
"eve": minor
---

Evals can start a session from a fixed earlier conversation with `t.session({ history })`, then send and grade the next turn.

`history` takes ordered user and assistant text. eve adds it to the session's model history with the first message, and runs no model, tool, or hook for it. `client.sessions.create({ history })` accepts the same option.

The eve channel rejects `history` in a create request with `403` unless its auth grants the caller `allowHistoryImport`, a new `EveAuthResult` flag that `eveVercelOidc` subject entries can also set. Without the grant, client requests still can't supply history.
