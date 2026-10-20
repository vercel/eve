---
"eve": patch
---

Self-hosted `eve build` output now carries a build identity derived from its contents. eve exposes it to Workflow Worlds as `WORKFLOW_DEPLOYMENT_ID` unless that variable is already set, and records it in `eve build --profile` reports.
