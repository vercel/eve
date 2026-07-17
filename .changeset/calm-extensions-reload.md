---
"eve": patch
---

Build mounted source-backed workspace extensions before `eve dev` compiles the agent, then rebuild only the affected extension when its source changes. Failed extension builds keep the previous dist and active development generation serving.
