---
"eve": patch
---

`agent.step` spans for AI Gateway model calls now record the Gateway's session affinity report: the session ID, where that ID came from, the affinity outcome, and the pinned and displaced providers. Use these attributes to match a step to its session in the AI Gateway logs Sessions view.
