---
"eve": minor
---

Replace the `agent.session` span with replay-stable, per-activation traces in schema v4, linked to their callers and correlated by conversation ID. Dispatch uses `agent.action` and `execute_tool` spans with prompt settlement export; `invoke_agent` retains standard GenAI token totals, and eve's trace-content policy governs error details without changing unrelated logging.
