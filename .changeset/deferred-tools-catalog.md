---
"eve": minor
---

Every agent now has `eve__search` and `eve__execute`, which reach tools marked `deferred: true`, agents marked `tool: "deferred"`, and every connection tool without growing the model's tool list. They replace `connection_search` and `connection_execute`, and stream events, approvals, hooks, and traces now name each connection tool call `<connection>__<tool>`. `eve__search` never asks the user to sign in: it lists a connection that needs sign-in under the connection's own name, and `eve__execute` on that name, such as `eve__execute({ tool: "linear" })`, asks the user to sign in. `eve__search` takes a required `query`; a query such as `linear__` searches only that connection's tools.

Breaking changes:

- The tools eve adds itself now live in the `eve` namespace: `task_wait` is `eve__task_wait`, `task_cancel` is `eve__task_cancel`, and `final_output`, the tool a session with an output schema calls to deliver its structured result, is `eve__reply`. The catalog tools are `eve__search` and `eve__execute`. Update evals, approval policies, hooks, and channel code that match `task_wait`, `task_cancel`, or `final_output` by name. A turn held on `task_wait` when you upgrade stays held until the next message or a cancel.
- eve reserves the `eve` namespace. A tool, subagent, skill, connection, or extension mount named `eve` or starting with `eve__` now fails to build, or fails when the agent loads or a dynamic entry resolves; rename it. `search`, `execute`, `task_wait`, `task_cancel`, and `final_output` are ordinary names again.
- A connection owns its name and every name starting with `<name>__`. A tool, subagent, or connection under another connection's prefix is rejected at build time, and a dynamic one when it resolves.
- Dynamic tool map keys must be legal tool names: ASCII letters, digits, `_`, and `-`, starting with a letter, up to 64 characters.
- Connection approvals are keyed by `<connection>__<tool>` instead of a `[connection, tool]` pair, so saved "always approve" decisions for connection tools reset.
- A `connection_execute` call still waiting for approval when you upgrade fails when someone answers it, with "The tool "connection_execute" is no longer available, so the call didn't run."
- Removed: the `parentCallId` field on `tool-call` actions in `actions.requested` events, and the `agent.action.parent_call_id` span attribute. The subagent `parentCallId` on `session.started` invocation metadata is unchanged.
