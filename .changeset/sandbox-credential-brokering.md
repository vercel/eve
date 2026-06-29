---
"eve": patch
---

Add route-level Vercel Sandbox authorization that resolves credentials for the active principal, injects them through firewall transforms, and clears them after each step. Interactive credentials requested during authored tool execution use eve's existing authorization pause and resume lifecycle.
