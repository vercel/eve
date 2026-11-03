---
"eve": patch
---

Update the bundled Workflow runtime to 5.3.0 and create new runs with Workflow spec version 9, which drives each run from one orchestrator.

Workflow 5.3.0 lets parallel branches advance inline steps without waiting on slower siblings, reuses resolved hooks to skip token lookups on later resumes, and fixes a step that could be created but never run when two executions raced in one process. eve now sets `WORKFLOW_SPEC_VERSION=9` before it creates a world unless `WORKFLOW_SPEC_VERSION` or `WORKFLOW_SEALED_LOG` is already set. Set `WORKFLOW_SPEC_VERSION=8` to keep creating spec 8 runs. Existing runs keep their version.
