---
"eve": patch
---

eve no longer deletes dynamic skill files from the sandbox; it only writes them. Previously, a dynamic skill that stopped returning `files` (for example, because the app now bakes them into its sandbox snapshot) had its whole `$HOME/.agents/skills/<name>` directory removed from a reused sandbox. Files from an earlier result now stay in place when a skill changes, drops its `files`, or is no longer returned.
