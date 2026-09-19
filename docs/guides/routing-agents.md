---
title: "Build an Agent Router"
description: "Route delegated tasks to specialist eve agents with agentRouter, clear route descriptions, and routing evals."
contentType: "How-to"
---

<!--
Content plan
- Overview: Build one root agent that delegates through a dedicated router.
- Goal: Configure, test, and troubleshoot routing between eve agents.
- Audience: Developers who have an eve project and need specialist delegation.
- Content: Choose a routing boundary, build the agentRouter path, test routing, customize selection, and diagnose failures.
- Open questions: Whether a future router template should replace the inline customer-service example.
-->

Use `agentRouter()` when the root model should decide whether to delegate, but a dedicated router should choose the specialist. The router compares the task with each agent's description, invokes one target, and returns that result to the root model.

This guide builds a customer-service router with `billing` and `support` specialists:

```text
incoming request
       |
   root model
       |
  agentRouter()
    /       \
billing   support
```

## Choose the routing boundary

Choose who should make each decision before you add agent files.

| Requirement                                                    | Use                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Let the root model choose a visible specialist directly        | [Declared subagents](/docs/subagents#declared-subagents)                                                                         |
| Let the root model delegate, then use JEV to choose the target | `agentRouter()`                                                                                                                  |
| Route across a subset or use custom selection criteria         | `defineWorkflowTool` with `ctx.agents` and `ctx.agent()`                                                                         |
| Choose the agent before the root model runs                    | Application or channel code with separately addressable [workspace agents](/docs/concepts/project-structure#several-root-agents) |

`agentRouter()` controls specialist selection after the root calls the `agent` tool. It does not intercept every incoming request before the root model runs.

## Create the router

Start from an existing [eve project](/docs/getting-started). Add this structure:

```text
agent/
├── agent.ts
├── instructions.md
├── tools/
│   └── agent.ts
└── subagents/
    ├── billing/
    │   ├── agent.ts
    │   └── instructions.md
    └── support/
        ├── agent.ts
        └── instructions.md
```

### Define the specialists

Give each specialist a distinct `description`. The router uses these descriptions as its selection criteria.

```ts title="agent/subagents/billing/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Resolve invoices, duplicate charges, refunds, subscriptions, and payment questions. Do not troubleshoot product behavior.",
  model: "anthropic/claude-opus-4.8",
  tool: false,
});
```

```ts title="agent/subagents/support/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Troubleshoot setup, errors, integrations, and product behavior. Do not answer invoices, charges, refunds, or payment questions.",
  model: "anthropic/claude-opus-4.8",
  tool: false,
});
```

`tool: false` hides the direct `billing` and `support` tools from the root model. Both agents remain available to workflow tools through `ctx.agents` and `ctx.agent()`.

Avoid broad descriptions such as “helps customers.” Overlapping descriptions make selection less predictable.

### Scope each specialist

Give each specialist the instructions and capabilities it needs:

```md title="agent/subagents/billing/instructions.md"
# Role

Resolve billing requests using the billing tools and policies available to you.
Do not troubleshoot product behavior or claim that an action occurred without evidence.
```

```md title="agent/subagents/support/instructions.md"
# Role

Resolve product setup, integration, error, and behavior questions.
Do not answer billing questions or claim that a billing action occurred.
```

A declared subagent does not inherit the root's authored instructions, tools, connections, or skills. Add each required capability under that specialist's directory. See [The isolation boundary](/docs/subagents#the-isolation-boundary) for sandbox and state behavior.

### Install the router in the `agent` tool slot

Export `agentRouter()` from `agent/tools/agent.ts`:

```ts title="agent/tools/agent.ts"
import { agentRouter } from "eve/tools/agent-router";

export default agentRouter();
```

This replaces the model-facing built-in `agent` tool with a blocking workflow tool. The root model sees one `agent` tool instead of the hidden specialist tools.

The router accepts:

```ts
{
  message: string;       // complete task for the selected agent
  outputSchema?: object; // optional JSON Schema for the selected agent's result
}
```

### Tell the root when to delegate

Configure the root model as usual. Omit the root `description` when the router should choose only declared specialists:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

Then tell the root to use the router:

```md title="agent/instructions.md"
# Role

Coordinate customer requests through the `agent` tool.

# Delegation

- Delegate billing and product-support requests through `agent`.
- Put the complete request and relevant known context in `message`.
- For a request that spans both domains, split it into two focused calls.
- Ask for clarification when the request does not contain enough routing detail.
- After delegated work finishes, give the customer one concise response.
```

The selected child does not see the root's conversation history. Include all relevant context in `message`, and do not send data that the child should not receive.

## How target selection works

When the root calls `agent`, `agentRouter()`:

1. Reads the effective callable-agent descriptions from `ctx.agents`.
2. Ignores targets with an empty description.
3. Invokes the only described target without evaluation, or asks the default JEV evaluation model to choose among multiple targets.
4. Calls the selected target through `ctx.agent()`.
5. Returns the selected agent's result as the blocking workflow tool result.

The snapshot can include hidden local, remote, workspace, and active dynamic subagents. Availability and authorization are checked again when the router invokes the target.

### Include a root copy

In a top-level root workflow, `ctx.agents.agent` represents a copy of the root. It has an empty description unless `agent/agent.ts` defines one. Add a description to make the root copy eligible:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Coordinate requests that require multiple specialist domains.",
  model: "anthropic/claude-opus-4.8",
});
```

The invocation name `agent` is reserved for this root-copy target. Delegated root copies do not receive the router and cannot select another root copy recursively.

## Test the routes

Start the project and exercise each route:

```bash
npm run dev
```

| Request                               | Expected target                                    |
| ------------------------------------- | -------------------------------------------------- |
| “Why was I charged twice?”            | `billing`                                          |
| “The upload fails with a 403.”        | `support`                                          |
| “Something is wrong with my account.” | The root asks for clarification before delegation. |

Turn these cases into evals. Assert the selected agent instead of grading only the final prose:

```ts title="evals/routing/billing.eval.ts"
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Routes duplicate charges to billing and not support.",
  async test(t) {
    const turn = await t.send("Why was I charged twice for one month?");

    turn.expectOk();
    turn.calledTool("agent", { count: 1 });
    turn.event("subagent.called", {
      data: { name: "billing" },
      count: 1,
    });
    turn.notEvent("subagent.called", {
      data: { name: "support" },
    });
    t.succeeded();
    t.noFailedActions();
  },
});
```

Add cases for support, unclear intent, overlapping descriptions, and adversarial wording. Run them with:

```bash
eve eval routing
```

See [Evals](/docs/evals/overview) for configuration, datasets, and CI setup.

## Customize the router

Use `defineWorkflowTool` directly when you need a subset of `ctx.agents`, custom JEV instructions, another evaluation model, or deterministic business rules. Keep each specialist hidden with `tool: false`, select a target in the workflow, then call:

```ts
return ctx.agent(target, { message });
```

Run model-based selection inside a `"use step"` function so workflow replay records the decision. See [Route to a hidden subagent with JEV](/docs/tools/workflows#route-to-a-hidden-subagent-with-jev) for a complete implementation.

For rules that must run before any root-model inference, select a separately addressable workspace agent in application or channel code. A workspace member does not become a router target automatically. Declare it with `defineWorkspaceAgent` under the router's `agent/subagents/` directory when the router must also call it.

## Troubleshoot routing

| Symptom                                                    | Check                                                       | Next action                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The router reports no available described agents.          | Every candidate has an empty description or is unavailable. | Add distinct descriptions and check dynamic availability.                                            |
| The router selects the root unexpectedly.                  | The root has a non-empty description.                       | Remove that description or narrow it to the work the root copy should handle.                        |
| The root bypasses the router.                              | A specialist still has `tool: true`.                        | Set `tool: false` on every specialist managed by the router.                                         |
| The router chooses different targets for similar requests. | Specialist descriptions overlap.                            | Add mutually exclusive boundaries and routing evals.                                                 |
| The specialist lacks context.                              | The delegated `message` omits parent-conversation details.  | Include the complete task and relevant known facts.                                                  |
| The specialist cannot use a root capability.               | The capability exists only under the root agent.            | Add it under the specialist's directory.                                                             |
| The root never calls the router.                           | The root instructions leave delegation optional or unclear. | State when the root must call `agent`. Route before root inference if delegation cannot be optional. |

Routing is not an authorization boundary. Keep sensitive tools behind approvals, connection authorization, and route or session controls wherever those tools can run.
