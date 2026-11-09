---
"eve": major
---

Move `start` and `getRun` to `eve/experimental/workflow/api` and `getWorkflowMetadata` to `eve/experimental/workflow`, so the stable Workflow entries carry only the primitives durable tools need.

`eve/workflow` keeps `createHook`, `createWebhook`, `sleep`, `FatalError`, and `RetryableError`, and `eve/workflow/api` keeps `resumeHook`. Run operations mostly overlap with `task` and `serve` tools and track a Workflow SDK model that is still changing, so they move to experimental entries without a compatibility promise. To migrate, import `start`, `getRun`, `WorkflowRun`, and `WorkflowRunStatus` from `eve/experimental/workflow/api`, and `getWorkflowMetadata` and `WorkflowMetadata` from `eve/experimental/workflow`. Importing a moved export from its old entry fails the build with an error that names the new entry.
