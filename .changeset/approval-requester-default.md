---
"eve": patch
---

Approvals without a `response` policy can now be approved or cancelled only by the principal whose turn requested the call, so a shared thread no longer lets another person run a tool under the requester's turn. Calls requested by unauthenticated or anonymous callers are unchanged. Tools that need other approvers define `approval.response`, which replaces the default.
