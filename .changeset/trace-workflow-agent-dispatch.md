---
"eve": minor
---

Advance `agent.trace.schema.version` from 3 to 4 and remove `agent.session` and `agent.channel.delivery`: update dashboards to use per-activation `invoke_agent` spans, linked to callers and grouped by `gen_ai.conversation.id`. Single turn-bound channel deliveries annotate their activation directly; other delivery lifecycles do not emit agent spans. Dispatch uses `agent.action` and `execute_tool`, preserves standard GenAI usage totals and trace-content restrictions, and rejects baggage overflow; settlement materializes spans without draining exporters, and conversation IDs remain available without instrumentation.
