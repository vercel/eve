---
"eve": minor
---

Advance `agent.trace.schema.version` from 3 to 4 and remove `agent.session`: update dashboards to use per-activation `invoke_agent` spans, linked to callers and grouped by `gen_ai.conversation.id`. Single turn-bound channel deliveries now annotate their activation directly, while standalone delivery spans remain for fan-in and deliveries without an activation. Dispatch uses `agent.action` and `execute_tool`, preserves standard GenAI usage totals and trace-content restrictions, and rejects baggage overflow; settlement materializes spans without draining exporters, and conversation IDs remain available without instrumentation.
