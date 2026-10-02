---
"eve": patch
---

Sessions from eve 0.68 and earlier now hand off to a newer deployment even when the agent has since removed a `defineState` key. The removed state is dropped with a warning instead of keeping the session on its old deployment.
