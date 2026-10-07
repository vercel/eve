---
"eve": minor
---

Every agent now has `search` and `execute`, which reach tools marked `deferred: true`, agents marked `tool: "deferred"`, and every connection tool without growing the model's tool list. They replace `connection_search` and `connection_execute`, and stream events, approvals, hooks, and traces now name each connection tool call `<connection>__<tool>`. `search` never asks the user to sign in: it lists a connection that needs sign-in under the connection's own name, and `execute` on that name, such as `execute({ tool: "linear" })`, asks the user to sign in.

Breaking changes:

- `search` and `execute` are reserved: rename an `agent/tools/search.ts` or `agent/tools/execute.ts`, a subagent with either name, or a dynamic tool map key `search` or `execute`.
- A connection named after a tool eve adds at runtime (`search`, `execute`, `task_wait`, `task_cancel`, or `final_output`) now fails to build, and a dynamic connection with one of those names fails when it resolves. Rename the connection.
- A connection owns its name and every name starting with `<name>__`. A tool, subagent, or connection under another connection's prefix is rejected at build time, and a dynamic one when it resolves.
- Dynamic tool map keys must be legal tool names: ASCII letters, digits, `_`, and `-`, starting with a letter, up to 64 characters.
- Connection approvals are keyed by `<connection>__<tool>` instead of a `[connection, tool]` pair, so saved "always approve" decisions for connection tools reset.
- A `connection_execute` call still waiting for approval when you upgrade fails once approved, with "The approved tool is no longer available."
- Removed: the `parentCallId` field on `tool-call` actions in `actions.requested` events, and the `agent.action.parent_call_id` span attribute. The subagent `parentCallId` on `session.started` invocation metadata is unchanged.
