---
"eve": minor
---

Remove the `conversation` / `task` run mode. Every session now parks after each turn instead of ending, including markdown schedules and MCP `agent_start` invocations. `agent_get` reports `completed` once the turn settles, and a recoverable model failure fails only that turn. The `mode` option is gone from `ChannelAddress` and Chat SDK `send(...)` options, as well as from audience and trace-policy inputs. The eve HTTP channel now ignores a `mode` field on session creation, and the agent-level `outputSchema` applies only to the first turn of a fresh subagent delegation.
