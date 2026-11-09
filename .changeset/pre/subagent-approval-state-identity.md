---
"eve": patch
---

Fixed subagent approvals answered from Slack, or with any `state` on the response, failing the subagent with "Session delivery has no identity" instead of running the approved call.

Thanks @Phelickz for reporting this in #5726.
