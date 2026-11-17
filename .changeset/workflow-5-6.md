---
"eve": patch
---

Update the bundled Workflow runtime and worlds to the Workflow 5.6.1 release, which stores the local world in one SQLite database.

The local world used by `eve dev` and by `eve start` without a configured world now keeps its runs, queue state, and streams in `.eve/.workflow-data/world.db` instead of one JSON file per entity. Each event and the run, step, wait, and hook changes it makes now commit together, so a process killed mid-write no longer leaves a run half-written. Run data written by earlier eve versions is not migrated, so sessions that were in progress before the upgrade cannot resume. The old `runs`, `events`, `steps`, `hooks`, `waits`, `streams`, `snapshots`, and `.locks` directories stay in place unread and can be deleted.

`eve start` now uses the local world's own queue authentication and restart recovery. Deliveries to the workflow route must carry the key the world keeps in `.eve/.workflow-data/queue-auth-key`, `eve start` refuses to start with `WORKFLOW_QUEUE_AUTH=off`, and recovery also re-arms the timers of runs that were sleeping. `eve logs` reads the local world without replacing that key, and a store written by a newer eve version now asks you to upgrade eve.
