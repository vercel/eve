---
"eve": patch
---

Hosted agents start faster: the bundled manifest is checked when the agent is built instead of on every cold start, the workflow driver code ships as plain text without an inline source map in production builds, and error-message formatters are created only when an error needs them.
