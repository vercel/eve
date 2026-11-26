---
"eve": minor
---

Evals can start a session from fixed prior conversation with `t.session({ history })`, then send and grade the next turn without running earlier turns through a model.

`history` accepts ordered user and assistant text (`SessionHistoryMessage`, exported from `eve/evals` alongside `EveEvalSessionOptions`) and joins model history with the first message without running earlier turns, tools, or hooks. It works out of the box with local `eve eval` through a dev-only route that is omitted from production builds, leaving `eve/client` and `POST /eve/v1/session` unchanged.

Thanks @matchai for raising this eval gap and prototyping the initial proposal in #6854.
