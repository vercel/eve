---
"eve": minor
---

Rename the terminal display flags on `eve dev` and `eve remote connect` to `--show-tools`, `--show-reasoning`, `--show-subagents`, and `--show-connection-auth`.

The old `--tools`, `--reasoning`, `--subagents`, and `--connection-auth` display flags are no longer accepted, and rendering defaults are unchanged. Model reasoning effort still uses `--reasoning` on `eve init` and `eve set model`.
