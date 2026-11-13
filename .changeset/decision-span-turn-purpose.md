---
"eve": patch
"@vercel/agent-runs": minor
---

Decision spans now name their turn and purpose, and record their outcome and answers when the trace records outputs.

`decision <model>` spans carry `agent.turn.id` and `agent.decision.purpose` (`model-selection`, `tool-approval`, `agent-routing`, or `custom`), so Agent Runs can place a model-selection decision in a turn that is still running. `agent.decision.outcome` and `agent.decision.answers` are output content: they are recorded only when outputs are, and dropped for any destination that declines outputs. `AgentRun.decision` accepts an optional `purpose`, and completing a decision with `output` records its answers.
