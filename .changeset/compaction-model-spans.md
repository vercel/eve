---
"eve": patch
"@vercel/agent-runs": minor
---

A context compaction's summary request during a turn now exports its own `chat <model>` span under the turn's `invoke_agent` span, with its token usage and `ai.settings.context.eve.compaction.request=summary`, so traces no longer undercount compacting turns.

Model spans now also carry `agent.turn.id`. `@vercel/agent-runs` adds `TurnOperation.modelCall` for model calls a turn makes outside its steps.

Thanks @zackleman for reporting this in #5922.
