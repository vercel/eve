---
"eve": patch
---

The bundled `eve dev` self-modification subagent is now offered only to the local developer: sessions authenticated by `localDev()` or by the linked project's Vercel development token. Other authenticated callers of a development server, such as chat users reaching it through a tunnel, can no longer ask it to edit the authored `agent/` source.
