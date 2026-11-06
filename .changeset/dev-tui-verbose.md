---
"eve": minor
---

`eve dev` and `eve remote connect` replace the six display flags with one `--verbose` flag that shows tool output, reasoning, and subagent activity in full.

`--show-tools`, `--show-reasoning`, `--show-subagents`, `--show-connection-auth`, `--assistant-response-stats`, and `--context-size` are removed; connection sign-ins always show. The terminal UI also changes in smaller ways: `/loglevel` and `Ctrl+L` apply to new output instead of re-rendering the transcript, rebuild progress shows in the status line and a failed rebuild appears as an error, logs print as soon as they arrive, and consecutive calls to the same tool share one row.
