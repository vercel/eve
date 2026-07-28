---
"eve": patch
---

Development runtime snapshots no longer copy legacy root-level `.workflow-data` directories. Projects with large local workflow histories avoid redundant multi-gigabyte snapshot copies and related disk-space failures.
