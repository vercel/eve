---
"eve": minor
---

The MCP channel's `agent_get` now reports the same progress as Slack's typing indicator in `statusMessage`: the agent's latest reasoning heading or sentence, `Thinking...`, or `Writing a reply...`, when no tool call is running.

Thanks @pranavmital for the feedback on #5311.
