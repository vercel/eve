---
"eve": patch
---

The eve channel can offer slash commands declared with `defineCommand`, and the terminal UI shows and runs them next to its built-in commands.

A command's `run` gets the argument, the caller, and the client's current `session` with `clear`, `compact`, `cancel`, and `end`. It returns an optional `message` shown only to the caller and an optional `send`, which eve delivers into the session as the caller's next message through `onMessage`. Commands can declare `aliases`, `arguments: "text"`, and `session: "required"`. The eve channel serves commands at `GET /eve/v1/commands`, `POST /eve/v1/commands/:name`, and `POST /eve/v1/session/:sessionId/commands/:name`, exposed in the TypeScript client as `client.commands()` and `client.runCommand()`.
