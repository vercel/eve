---
"eve": minor
---

Replace the terminal display flags on `eve dev` and `eve remote connect`: `--tools` → `--show-tools`, `--reasoning` → `--show-reasoning`, `--subagents` → `--show-subagents`, and `--connection-auth` → `--show-connection-auth`; the old display names are no longer accepted. Model reasoning effort still uses `--reasoning` on `eve init` and `eve set model`, and rendering defaults are unchanged.
