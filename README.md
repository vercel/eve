# PR 2697 trace-policy proof

Jaeger screenshots captured from the weather-agent validation for vercel/eve#2697.

- `redacted-agent-session.png`: emitted `agent.session` trace with metadata-only AI spans.
- `redacted-workflow.png`: ambient Workflow trace for the same redacted run.
- `dropped-workflow.png`: ambient Workflow trace when `tracePolicy` returned `false`; AI spans remain metadata-only and no `agent.session` trace is emitted.
