---
"eve": patch
---

Building agents for Vercel now fails when the agents in one deployment would run different eve versions.

The agents share the deployment's Workflow runs, so a run started by one eve version and replayed by another failed with `CORRUPTED_EVENT_LOG`. Install a single eve version for the project, for example by declaring `eve` only in the root `package.json`.
