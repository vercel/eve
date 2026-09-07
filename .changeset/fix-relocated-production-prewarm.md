---
"eve": patch
---

Fix `eve start` failing when an app built on another machine is deployed to a different directory. Sandbox prewarming now resolves authored modules from the deployed app while preserving TypeScript aliases and workspace package resolution.
