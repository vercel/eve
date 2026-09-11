---
"eve": patch
---

Slack channels can route each input request, including tool approvals and `ctx.ask()` questions, to the shared thread or the triggering user's direct messages with the `approvalChannel` callback. Custom input renderers can also render questions or approvals outside the session thread with an authenticated return route, and `ctx.ask()` now carries bounded application metadata through durable `input.requested` events.
