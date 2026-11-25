---
"eve": minor
---

Fork a session into a new one with `forkFrom`, carrying its conversation, tool calls, and a copy of its sandbox, from the eve HTTP API, `eve remote connect --session`, and the web client.

`eve remote connect` also signs in to agents whose eve HTTP API publishes OAuth protected-resource metadata, the way MCP clients do: dynamic client registration and a browser login, with tokens kept under `~/.eve/agent-oauth`.
