---
"eve": patch
---

Update the bundled Workflow runtime and worlds to the Workflow 5.7.0 release, which fixes stranded runs after a crashed first delivery and reduces World reads on hook-started runs and hook resumes.

The release also lowers the default `WORKFLOW_ORCHESTRATOR_LINGER_MS` to 5 seconds and keeps orchestrator deliveries alive through short sleeps. With the Postgres world, run `bootstrap` before deploying the upgrade so the database has migration 0032.
