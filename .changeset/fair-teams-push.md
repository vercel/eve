---
"eve": patch
---

Install and enforce one stable agent-scoped workflow queue namespace before Nitro channel and schedule routes create workflow runtimes, so external entrypoints enqueue runs onto the same queue namespace as the agent's workflow handlers without cross-agent process contamination.
