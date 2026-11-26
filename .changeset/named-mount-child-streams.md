---
"eve": patch
---

`followAgents` and subagent stream reads now reach a remote child mounted at a named path such as `/eve/<name>`, instead of returning 404.

Thanks @phoenixdahdev for the reproduction in #6295.
