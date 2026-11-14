---
"eve": patch
---

Self-hosted builds on the default local Workflow World now hand queue messages to the workflow handler in process, as builds with a configured World already did, instead of sending each one over HTTP to their own server. A fresh `eve start` reaches its first reply sooner.
