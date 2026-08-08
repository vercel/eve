---
"eve": patch
---

Sessions no longer stall while an interactive authorization challenge is open: ordinary messages now run as normal turns during the wait, and the OAuth callback still completes the challenge. Session timeouts are also honored during an open challenge.
