---
"eve": patch
---

Fix a terminal model-call failure (e.g. an invalid API key or a structural 4xx) inside a subagent run being reported to the delegating parent as a successful, empty-output result instead of an error. The parent orchestrator would previously log the run as completed even though the subagent's model call failed.
