---
"eve": patch
---

Skip `createSessionStep` and `resolveInitialTurnCallerStep` when booting local subagent sessions, defer starting `sessionTimeoutWorkflow` until a session first parks, and overlap terminal caller notification with sandbox cleanup and stream close.
