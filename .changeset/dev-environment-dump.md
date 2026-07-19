---
"eve": patch
---

`eve dev` now writes an environment dump next to each diagnostic log (`.eve/logs/dev-<instance>.dump`): one JSON document capturing eve, Node.js, and Vercel CLI versions, the Vercel CLI path, local session-store size, and running session stats (prompts, token usage, tool calls by name, subagent dispatches). `eve logs --dump` prints the dump and its JSONL log together as one parseable report.
