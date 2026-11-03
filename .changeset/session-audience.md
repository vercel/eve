---
"eve": minor
---

Expose the session's audience as `ctx.session.audience` in tools, hooks, and approval policies, so a policy can act differently in a public conversation.

The value is `"private"`, `"public"`, or `"unknown"`, as eve classified the conversation when the session started. Local subagents have their parent's audience. Treat `"unknown"` like `"public"` in security policies.
