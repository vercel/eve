---
"eve": minor
---

Session `history` can carry the tool calls an assistant message made, so a session can start from a conversation that used tools.

An assistant entry takes `toolCalls`, each with a `name`, an optional `input`, and either an `output` or an `error`. The model reads the calls and their results before the entry's `text`. eve runs no tool, approval, or hook for them, and records them in `delivery.consumed` history without `call.*` events. The option works wherever `history` does: a channel's `create()` and `send()`, `onMessage`, and `t.session({ history })` in evals.

Thanks @FranciscoMoretti for the request and prototype in #5340.
