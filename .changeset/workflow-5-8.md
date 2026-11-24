---
"eve": patch
---

Update the bundled Workflow runtime and worlds to the Workflow 5.8.0 release, which fixes spec 9 run-ahead log corruption, delivers aborts directly to in-process inline steps, and sends a run's wait timers concurrently.

The release also fixes a zero-retention purge deadlock and a stream-write completion race on the Postgres world. With `@workflow/world-postgres` 5.5.0, run `bootstrap` before deploying the upgrade so the database has migration 0033.
