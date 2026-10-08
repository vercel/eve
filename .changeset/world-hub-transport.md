---
"eve": minor
---

Add `eve/world-hub`, a Workflow World that forwards every World call over HMAC-signed HTTP to an external host, and `eve/world-hub/server` with the matching request handler and step dispatcher. Selecting it (`experimental.workflow.world: "hub"` or `WORKFLOW_TARGET_WORLD=hub`) also mounts the flow handler at `/eve/v1/workflow/dispatch` and gives the server function the flow function's `maxDuration`/memory. Default builds are unchanged.
