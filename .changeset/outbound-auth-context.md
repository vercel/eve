---
"eve": patch
---

Outbound auth functions for remote agents now receive an `OutboundAuthContext` with the dispatched tool call's raw `message`, `remoteAgentName`, and `callId`, so custom auth schemes can derive credentials from what is being sent. Existing zero-argument auth functions keep working unchanged.
