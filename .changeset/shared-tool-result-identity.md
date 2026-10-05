---
"eve": patch
---

Fix a spurious `toolResultFrom` identity warning when one tool definition is mounted under more than one name, such as the code extension's `grep` tool in its worker subagent. `toolResultFrom` now matches results from every name that definition is mounted under.
