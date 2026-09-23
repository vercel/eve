---
"eve": patch
---

Dynamic skills no longer start a sandbox to announce or load instructions. Skills that return supporting files are written only when their contents or sandbox change, and a changed package replaces its previous files instead of leaving stale ones behind.
