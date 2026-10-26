---
"eve": patch
---

The bundled `eve dev` self-modification subagent is now offered only to the local developer: sessions authenticated by `localDev()` or by the linked project's Vercel development token. Chat users and principals from authored authenticators, including HTTP Basic operators, no longer get the editor and must edit files directly; there is no local authorization override, and callers forwarded by a same-machine tunnel can still get the editor if the channel uses `localDev()`.
