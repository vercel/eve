# PR 2697 trace-policy proof

Jaeger screenshots captured from the weather-agent validation for vercel/eve#2697.

- `redacted-agent-session.png`: emitted `agent.session` trace with metadata-only AI spans.
- `redacted-workflow.png`: ambient Workflow trace for the same redacted run.
- `dropped-workflow.png`: ambient Workflow trace when `tracePolicy` returned `false`; AI spans remain metadata-only and no `agent.session` trace is emitted.

# PR 2706 GenAI span proof

Jaeger screenshots captured from a deterministic `agent-tui-client` request that delegated to a separately running `weather-agent` service and called `get_weather`.

- `genai-distributed-trace.png`: complete two-service trace with parent and remote-agent invocation spans.
- `genai-invoke-agent.png`: GenAI details for `invoke_agent weather-agent`, including conversation identity and aggregated token usage.
- `genai-execute-tool.png`: GenAI tool-call details for `execute_tool get_weather`, including the Lisbon arguments and structured result.
