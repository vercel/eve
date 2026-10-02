---
"eve": patch
---

Added `toolCallState(conversation, callId, { streaming })`, exported from `eve/client`, `eve/react`, `eve/vue`, and `eve/svelte`, which reads a tool call's status from the session projection and its content from the message part. `eve dev`, eval tool facts, `noFailedActions`, and the ACP adapter read call status the same way, so a failed subagent now fails `noFailedActions` while a denied or stopped call doesn't, and ACP reports a task call when its task settles rather than when it starts. A call that hands work to a task reports that work's outcome, so `calledTool` sees a call whose task was cancelled as `cancelled` rather than `completed`.
