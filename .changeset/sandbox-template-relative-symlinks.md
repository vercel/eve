---
"eve": patch
---

Relative symlinks in a sandbox template or read-only sandbox resources now stay relative when eve copies them for a session. Before, the copy pointed each link back into the shared template. A write through the link from one `just-bash` session then changed the template, and template pruning broke the link in live sessions.
