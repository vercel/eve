---
"eve": patch
---

Merge assembled system instructions into one system message at the model-call boundary. This avoids provider failures on models that reject multiple system messages while preserving history and dynamic instruction lifecycles.
