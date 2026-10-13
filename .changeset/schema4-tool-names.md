---
"eve": patch
---

The agent tracing library now writes schema 4's `agent.action.kind`, `agent.action.name`, and `agent.action.outcome` on tool and approval spans itself, so hosts other than eve render correctly in Agent Runs. eve's trace output is unchanged.
