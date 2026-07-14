---
title: "Dynamic Workflows"
description: "The experimental Workflow tool: let the model orchestrate its own subagents from model-authored JavaScript as one durable step."
---

The experimental `Workflow` tool lets the model write JavaScript that coordinates the agent's own subagents as a single durable step. The program can run them in sequence, feed one result into the next, fan out over a list, and combine the results. You enable the capability and the model decides and runs the orchestration.

A single turn can already call several subagents, and parallel tool calls dispatch concurrently. What a workflow adds is _programmatic_ coordination. The program decides how many subagents to run based on an earlier result, which output feeds which call, and how to combine everything. That is logic the model cannot express as a few one-off calls.

## Enable the Workflow tool

Export the experimental Workflow definition from `agent/tools/workflow.ts`. The helper name carries the "experimental" warning, but the tool the model actually sees is named `Workflow`.

```ts title="agent/tools/workflow.ts"
import { experimental_workflow } from "eve/tools";

export default experimental_workflow();
```

Without that file, the `Workflow` tool stays off. It earns its keep only when the agent has subagents (or the built-in `agent`) worth coordinating:

```ts title="agent/subagents/analyst/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Analyzes one metric: queries, computes, writes a short finding.",
  model: "anthropic/claude-opus-4.8",
});
```

When asked for a weekly business review, the model picks the metrics, runs one `analyst` per metric in parallel, and combines the findings. The program below is the kind of JavaScript the model authors. It fans `analyst` out over a runtime-decided list of metrics and merges the results:

```js
const metrics = ["revenue", "signups", "churn"];
const findings = await Promise.all(
  metrics.map((metric) => tools.analyst({ message: `Summarize last week's ${metric}.` })),
);
return findings.join("\n\n");
```

Each `tools.analyst(...)` call dispatches a child subagent, so the parent stream records one `subagent.called` per metric and one `subagent.completed` as each finishes:

```json
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_1", "childSessionId": "ses_a1", "sequence": 0 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_2", "childSessionId": "ses_a2", "sequence": 1 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_3", "childSessionId": "ses_a3", "sequence": 2 } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_1", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_2", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_3", "output": "..." } }
```

## What a workflow can orchestrate

A workflow reaches only this agent's own agents: the built-in `agent` (a copy of itself), declared [subagents](../subagents), and [remote agents](./remote-agents). That is the whole list. No files, network, shell, skills, or connections. A workflow is a coordination layer over subagents, not a place to do other work. Each call can still request structured output via `outputSchema`, exactly like a direct subagent delegation.

## Caps on workflow-spawned subagents

Workflow orchestration is capped in two independent ways.

**Per-program call budget.** One Workflow program may dispatch at most `maxSubagents` subagent calls in total, counted across the whole program — sequential and parallel calls alike. Configure it on `experimental_workflow`; the default is 100. Calls beyond the budget do not start a child session; they resolve inside the program with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error result, and the budget is stated in the tool's description so the model sizes its fan-out to fit.

```ts title="agent/tools/workflow.ts"
import { experimental_workflow } from "eve/tools";

export default experimental_workflow({ maxSubagents: 4 });
```

**Root-only orchestration.** Only the root session receives `Workflow`. Children started by a workflow receive neither `Workflow` nor the built-in `agent`, so Workflow programs cannot recurse. A declared child can still call subagents defined in its own directory (see [Subagents](../subagents)).

## Where the JavaScript runs

The orchestration code never touches the agent's process. The runtime hands the program text to a small isolated JavaScript engine (a QuickJS sandbox) and runs it there. Nothing from the host realm crosses in, so there is no `process`, no `globalThis` from the agent, and no `import`/`require`. The program can reach exactly two things, the agent functions bridged in as `tools.<name>` and the ordinary language built-ins.

That is an allowlist, not a denylist. The sandbox cannot read files, open a socket, or see an environment variable because those are not present, not because each one is blocked in turn. When the program calls an agent function, that call bridges back out to the runtime, which dispatches it exactly like a direct delegation. The orchestration glue stays inside the sandbox.

## Durability, approvals, and observability

- **Durable.** The whole orchestration counts as one step. Subagents dispatched together run concurrently, and if a run parks (suspends durably without holding compute; see [Execution model & durability](../concepts/execution-model-and-durability)) on a long-running or human-gated child, it resumes where it left off after a restart.
- **Approval-safe.** A subagent that needs human approval (HITL, human-in-the-loop) mid-run surfaces its request to the user, and the workflow picks back up once that is answered, same as direct delegation.
- **Observable.** Every orchestrated subagent emits the usual `subagent.called` / `subagent.completed` events on the parent stream and gets its own child session and stream. The telemetry matches direct delegation, so existing dashboards and cost attribution keep working.

## What to read next

- Declare the subagents a workflow orchestrates → [Subagents](../subagents)
- Call another deployment as one of those agents → [Remote agents](./remote-agents)
- The `agent/tools/` opt-in mechanism → [Default harness](../concepts/default-harness)
