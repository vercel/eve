---
"eve": patch
---

Cap recursive subagent delegation at three child-session levels by default, configurable with `defineAgent({ limits: { maxSubagentDepth } })`. At the limit, eve no longer advertises subagent tools and blocks stale delegated calls before starting another child session.
