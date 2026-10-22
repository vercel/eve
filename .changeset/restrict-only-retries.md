---
"eve": patch
---

Model-call retries are decided by restrictive policies that combine without ordering: any policy can stop a retry, and none can force one. Retry behavior is unchanged.
