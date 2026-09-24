---
"eve": patch
---

`mcpCapabilitiesChannel` subagent calls now wait for background work the subagent starts, such as its own subagents, and return the answer given after it settles instead of an interim reply. Cancelling a call at the 150-second limit, or after a declined question, also cancels that background work.
