---
"eve": patch
---

Prevent channel HITL responses from carrying channel-local metadata into strict session-inbox payloads. Channel and session `respond()` calls now reject extra response keys during typechecking, including in user-authored channels.
