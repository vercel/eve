---
"eve": patch
---

Start every `eve` command faster by loading the remote agent inspection used by `eve remote info --url` only when that command runs.

Each command previously loaded the eve client and the AI SDK on startup, about half of the CLI's startup work.
