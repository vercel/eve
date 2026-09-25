---
"eve": minor
---

Remove the `conversation` / `task` run mode. Every session now parks after each turn instead of ending, including markdown schedules and MCP `agent_start` invocations. `agent_get` reports `completed` once the turn settles, and a recoverable model failure fails only that turn. The `mode` option is gone from `ChannelAddress` and Chat SDK `send(...)` options, as well as from audience and trace-policy inputs. The eve HTTP channel now ignores a `mode` field on session creation. `outputSchema` is removed from `defineAgent`, `defineRemoteAgent`, `defineWorkspaceAgent`, dynamic subagent configs, agent info, the model-facing subagent and `agentRouter()` tool inputs, MCP `agent_start`, and channel `from(address).send()` / `respond()` options; request structured output per turn through the session API or `ctx.agent()`.
