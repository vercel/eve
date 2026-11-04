---
"eve": patch
---

Record whether Agent Runs export is on in the build's Vercel agent summary, so Vercel can leave default tracing off for projects that turn off Agent Runs.

`eve build` sets `agentRuns.enabled` to `false` when `agent/instrumentation/agent-runs.ts` default-exports `disableInstrumentation()`, and to `true` otherwise. Each agent in a multi-agent workspace records its own value.
