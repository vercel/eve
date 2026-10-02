---
"eve": patch
---

An installed extension mounted in both the root agent and a subagent now builds when its distribution has shared chunks in `dist/_chunks`. Each mount owns those chunks, so they read that mount's configuration and state instead of failing with `refers to multiple extension mounts`.
