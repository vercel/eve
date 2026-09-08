---
"eve": patch
---

Start a separate trace for each agent activation and link delegated execution back to its caller while preserving conversation correlation and trace-policy restrictions. Dispatch lifecycle spans are now `agent.action`; only actual agent execution uses `invoke_agent`.
