---
"eve": patch
---

Terminal model-call failures in delegated subagent runs (e.g. an unresolvable model id returning 404) now propagate to the parent as a failed subagent result instead of a successful empty output, so orchestrator sessions no longer report success when a delegation failed.
