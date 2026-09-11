---
"eve": patch
---

Slack channels can route each input request, including tool approvals and `ctx.ask()` questions, to the shared thread or the triggering user's direct messages with the `approvalChannel` callback. Direct-message requests include a preview of the Slack message that triggered the turn, while the original thread names the reviewer without exposing the request.
