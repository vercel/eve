---
"eve": patch
---

Spreading a channel into a new object with replaced routes, such as `{ ...slackChannel(), routes }`, now keeps its build metadata, so the Slack app manifest and Vercel Connect credentials still reach the build. The custom channels docs now describe wrapping an existing channel's routes as supported.
