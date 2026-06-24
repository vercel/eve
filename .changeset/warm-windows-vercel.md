---
"eve": patch
---

Fix Vercel CLI detection on Windows by invoking npm's command shims through `cmd.exe`, so an installed `vercel` command is no longer misreported as missing.
