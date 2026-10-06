---
"eve": patch
---

Added `toolCallState(conversation, callId, { streaming })` to the client and frontend bindings. Tool parts and ACP tool calls follow task outcomes rather than start receipts (an ACP task call still running when its turn fails ends as failed), withdrawn approvals render as denied, and results marked `isError` render as errors; public conversation fields and eval policy remain unchanged.
