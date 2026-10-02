---
"eve": patch
---

Restoring a session no longer loads the workflow runtime up front. It now loads when a subagent forwards an approval, sign-in, or question to its parent.
