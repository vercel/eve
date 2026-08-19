---
"eve": patch
---

Fix `vercel.json` services detection when a Vercel Root Directory is configured. The framework integrations now read `vercel.json` from the framework app root first, so a `services` declaration next to the app wins over the linked repository root's `vercel.json` — matching where Vercel itself reads the file from.
