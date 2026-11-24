---
"eve": minor
---

Update the bundled Workflow runtime and worlds to Workflow 5.8.0, use Workflow's default spec version (spec 10) for new runs, and export `rateLimit` and `RateLimitMaxWaitError` from `eve/experimental/workflow`.

Workflow 5.8.0 fixes spec 9 run-ahead log corruption, delivers aborts directly to in-process inline steps, sends wait timers concurrently, and fixes a zero-retention purge deadlock and stream-write completion race on the Postgres world. Set `WORKFLOW_SPEC_VERSION=8` to keep creating spec 8 runs, and with `@workflow/world-postgres` 5.5.0 run `bootstrap` before deploying the upgrade so the database has migration 0033.
