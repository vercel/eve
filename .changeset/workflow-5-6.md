---
"eve": patch
---

Update the bundled Workflow runtime and worlds to the Workflow 5.6.1 release, which stores the local world in one SQLite database.

The local world used by `eve dev` and by `eve start` without a configured world now keeps its runs, queue state, and streams in `.eve/.workflow-data/world.db` instead of one JSON file per entity. Each event and the run, step, wait, and hook changes it makes now commit together, so a process killed mid-write no longer leaves a run half-written. Run data written by earlier eve versions is not migrated, so sessions that were in progress before the upgrade cannot resume. The old `runs`, `events`, `steps`, `hooks`, `waits`, `streams`, `snapshots`, and `.locks` directories stay in place unread and can be deleted.
