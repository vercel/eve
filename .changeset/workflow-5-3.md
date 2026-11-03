---
"eve": patch
---

Update the bundled Workflow runtime to 5.3.0, which lets parallel branches advance inline steps without waiting on slower siblings, reuses resolved hooks to skip token lookups on later resumes, and fixes a step that could be created but never run when two executions raced in one process.
