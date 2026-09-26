---
"eve": minor
---

`ctx.agent(name)` in a workflow tool now returns a session with that agent: `send(message, { outputSchema, signal })` returns a response whose `result()` resolves the turn's `{ data, message, status }`, and the parent stream announces each session with `agent.started`, which `session.streamSubagent()` accepts. `ctx.agent(name, { message, agentId })` is removed, sessions end when the workflow run finishes, and remote agents now check a protocol version, so upgrade both deployments together.
