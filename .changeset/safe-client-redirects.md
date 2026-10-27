---
"eve": patch
---

Client requests now reject redirects by default, including session writes and event streams. Set `redirect: "manual"` to inspect redirect responses; explicitly opting into `"follow"` retains the previous automatic-follow behavior.
