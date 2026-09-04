---
"eve": patch
---

Report unsupported `eve/workflow` helper calls and workflow directives on channel or schedule handlers at build time when their callback context is known. Runtime errors now identify the helper and required context, and rejected schedule background work is logged.
