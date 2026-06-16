---
title: "Dynamic Workflows"
description: "The experimental Workflow tool: let the model orchestrate its own subagents from model-authored JavaScript as one durable step."
---

The experimental `Workflow` tool lets the model write JavaScript that coordinates the agent's own subagents as a single durable step: running them in sequence, feeding one result into the next, fanning out over a list, and combining the results. You flip on the capability; the model decides and runs the orchestration. Think of it as the agents-only slice of code mode.

A single turn can already call several subagents, and parallel tool calls dispatch concurrently. What a workflow adds is _programmatic_ coordination: how many subagents to run based on an earlier result, which output feeds which call, and how to combine everything. That's logic the model can't express as a few one-off calls.

## Enable it

Re-export the opt-in marker as the default export of `agent/tools/workflow.ts`. The marker name carries the "experimental" warning, but the tool the model actually sees is named `Workflow`.

```ts title="agent/tools/workflow.ts"
export { ExperimentalWorkflow as default } from "eve/tools";
```

Without that file, the `Workflow` tool stays off. It earns its keep only when the agent has subagents (or the built-in `agent`) worth coordinating:

```ts title="agent/subagents/analyst/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Analyzes one metric: queries, computes, writes a short finding.",
  model: "anthropic/claude-opus-4.8",
});
```

Ask for a "weekly business review": the model map-reduces `analyst` over the metrics it picks (width decided at runtime) and resumes if a child parks for approval.

## What it can orchestrate

A workflow reaches only this agent's own agents: the built-in `agent` (a copy of itself), declared [subagents](../subagents), and [remote agents](./remote-agents). That's the whole list. No files, network, shell, skills, or connections. It's a coordination layer over subagents, not a place to do other work. Each call can still request structured output via `outputSchema`, exactly like a direct subagent delegation.

## Where the JavaScript runs

The orchestration code never touches the agent's process. The runtime hands the program text to a small isolated JavaScript engine (a QuickJS sandbox) and runs it there. Nothing from the host realm crosses in: no `process`, no `globalThis` from the agent, no `import`/`require`. The program can reach exactly two things, the agent functions bridged in as `tools.<name>` and the ordinary language built-ins.

That's an allowlist, not a denylist. The sandbox can't read files, open a socket, or see an environment variable because those simply aren't present, not because each one is blocked in turn. When the program calls an agent function, that call bridges back out to the runtime, which dispatches it just like a direct delegation. The orchestration glue stays inside the sandbox.

## How it behaves

- **Durable.** The whole orchestration counts as one step. Subagents dispatched together run concurrently, and if a run parks on a long-running or human-gated child, it resumes where it left off after a restart.
- **HITL-safe.** A subagent that needs approval mid-run surfaces its request to the user, and the workflow picks back up once that's answered, same as direct delegation.
- **Observable.** Every orchestrated subagent emits the usual `subagent.called` / `subagent.completed` events on the parent stream and gets its own child session and stream. The telemetry matches direct delegation, so existing dashboards and cost attribution keep working.

## Relationship to code mode

Code mode is the broader version: the model drives _all_ of an agent's tools (files, shell, web, and agents) from JavaScript. A workflow carves out the agents-only slice, just the subagents. The two don't interfere. Enabling the `Workflow` tool leaves code mode untouched, and an agent can run both at once.

## What to read next

- Declare the subagents a workflow orchestrates → [Subagents](../subagents)
- Call another deployment as one of those agents → [Remote agents](./remote-agents)
- The `agent/tools/` opt-in mechanism → [Default harness](../concepts/default-harness)
