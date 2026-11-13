---
"eve": patch
"@vercel/agent-runs": minor
---

Decision spans now name their turn and purpose, and record per-question results as `gen_ai.decision.results` when the trace records outputs.

`decision <model>` spans carry `agent.turn.id` and `agent.decision.purpose` (`model-selection`, `tool-approval`, `agent-routing`, or `custom`), so Agent Runs can place a model-selection decision in a turn that is still running. Results follow the proposed OpenTelemetry GenAI decision conventions: choices, predicates, scores with their levels, and refusals, each keyed by the question's position. They are output content, recorded only when outputs are and dropped for any destination that declines outputs. `AgentRun.decision` accepts an optional `purpose`, and completing a decision with `output` records it as the results.
