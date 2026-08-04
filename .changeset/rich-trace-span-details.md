---
"eve": patch
---

Show far more of what local traces record in `eve traces`: span rows carry inline token/cost/tool chips, the header aggregates models, token totals, cost, and errors, and two new flags expose everything else — `--verbose` expands every span with all attributes and events, and `--json` dumps the full trace machine-readably.
