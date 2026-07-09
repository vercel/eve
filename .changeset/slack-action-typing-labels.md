---
"eve": patch
---

The Slack channel's default typing indicator for `actions.requested` now shows the action's contents instead of a generic `Running <tool>...` label: the tool name plus its most telling argument (`grep useEveAgent`, `read_file agent/agent.ts`), the subagent or remote-agent name for dispatched calls, and `+N more` for batches. The label helpers are exported from `eve/channels/slack` as `describeActionRequest` and `describeActionRequests` for use in custom handlers.
