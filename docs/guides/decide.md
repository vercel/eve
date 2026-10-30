---
title: Automatic Model Selection
description: "Choose agent models automatically or ask typed questions in your tools and application code."
---

`auto` from `eve/models` chooses an agent model from an allowlist before each turn's inference. `decide` from `eve/ai` asks typed questions in your own tools or application code. Both use the [AI SDK decision API](https://ai-sdk.dev/docs/ai-sdk-core/decisions). The decider can be a Vercel AI Gateway model ID or a decision model from an installed provider.

The AI SDK decision model specification is experimental and can change in
patch releases.

## Choose from Gateway models

Omit `model` to decide with `typesafe-ai/jev`, TypeSafe AI's [Jev decision model](https://vercel.com/i/what-is-jev). Like other AI SDK model strings, it resolves through Vercel AI Gateway unless the application configures a different global default provider.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

Configure Gateway authentication as for any other AI SDK model; there is no separate TypeSafe credential. During `eve dev`, a Gateway decider uses the connection selected through `/login`, unless a configured AI SDK default provider resolves string models. The TUI footer shows `dynamic model` and then the turn's resolved model, such as `dynamic model · openai/gpt-6-luna`.

Set `fallback` to keep the turn running when the decider is unavailable or returns an error. The fallback can be a Gateway model ID, an AI SDK language model instance, or an object with `model` and a `reasoning` override:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    fallback: "anthropic/claude-sonnet-5",
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

The fallback applies only to decider failures. When eve switches, it logs a warning with the decider error and the fallback model. Invalid prompts and cancelled turns don't use the fallback; see [Runtime behavior](#runtime-behavior).

## Use a provider directly

Install the provider package and pass its decision model. The provider owns its credentials and settings.

```sh
pnpm add @ai-sdk/typesafe-ai
```

```ts title="agent/agent.ts"
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    model: typeSafeAi.decisionModel("jev-latest"),
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

Any provider that implements the AI SDK `Experimental_DecisionModel` contract works.

## Route to provider models and set reasoning

The decider sees each option's key. A string value describes the Gateway model whose ID is the key. Use the object form for a provider instance, an alias, or a reasoning override.

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  reasoning: "medium",
  model: auto({
    options: {
      "openai/gpt-6-sol": "Hard problems",
      my_secret_model: {
        model: anthropic("sonnet-5"),
        description: "Routine work that can use the direct Anthropic provider",
        reasoning: "low",
      },
    },
  }),
});
```

The decider sees option keys, descriptions, and recent text messages, never provider credentials or model instances. When it selects `my_secret_model`, eve resolves the key back to the authored Anthropic model.

Supported reasoning values are `"provider-default"`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, and `"xhigh"`. Omit `reasoning` to inherit the agent's reasoning setting.

## Decide inside a tool

`decide` asks choice, score, or boolean questions about the state you pass it. It defaults to `typesafe-ai/jev` with the same authentication as `auto`. Pass `model` to use another decision model ID or a provider instance.

```ts title="agent/tools/classify-request.ts"
import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Choose the team that can help with a customer request.",
  inputSchema: z.object({ request: z.string().min(1).max(8000) }),
  async execute({ request }, ctx) {
    const result = await decide({
      state: { request },
      questions: {
        team: {
          type: "choice",
          instructions: "Select the team best suited to handle the request.",
          criteria: {
            billing: "Invoices, payments, and refunds",
            support: "Product questions and troubleshooting",
          },
        },
      },
      signal: ctx.abortSignal,
    });
    return { team: result.answers.team.choice };
  },
});
```

The choice above is typed as `"billing" | "support"`. Each answer appears under its question's key in `result.answers`, and `usage` holds normalized token usage. To use that choice to delegate while keeping specialist subagents out of the parent model's tools, see [Route to a hidden subagent with Jev](/docs/tools/workflows#route-to-a-hidden-subagent-with-jev).

`decide` accepts `model`, `state`, `questions`, `maxRetries`, and `signal`; pass `signal: ctx.abortSignal` to cancel with the tool call. Import `DecisionModel`, `DecisionState`, `DecisionStatePart`, `DecisionInput`, `DecisionQuestion`, `DecisionAnswer`, `DecisionOptions`, and `DecisionResult` from `eve/ai` to type reusable configs and handlers.

A model instance must implement decision model specification `v4`, the version AI SDK 7 supports. A matching `provider`, `modelId`, and `specificationVersion` alone is not enough. If the installed `ai` package does not export a decision API, `decide` throws an error that names the missing export. Validation, retries, and provider errors follow AI SDK semantics.

`decide` also works outside a tool and doesn't need an active eve session.

## Judge eval results

Eval authors can use `t.judge(...)` to turn decision answers into scored assertions, including batches of questions sharing one state. It uses `decide` and its default model. See [Judge](../evals/judge) for criteria, rubrics, and thresholds.

## Decide tool approvals

`auto({ model? })` from `eve/tools/approval` lets a decision model decide whether a tool call runs automatically or needs human approval. It accepts the same decision model strings and provider instances and defaults to `typesafe-ai/jev`:

```ts title="agent/tools/deploy.ts"
import { defineTool } from "eve/tools";
import { auto } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Deploy an application.",
  inputSchema: z.object({ environment: z.string() }),
  approval: auto({ model: "typesafe-ai/jev" }), // Uses AI SDK string-model resolution
  execute: ({ environment }) => deploy(environment),
});
```

The decision model reviews the tool name and input for dangerous effects. A caution, failed review, or incomplete input requires human approval. See
[Human-in-the-loop approvals](/docs/human-in-the-loop#approvals) for classifier
options and data handling, and the
[Auto-approve tool calls with Jev](https://vercel.com/kb/guide/auto-approve-tool-calls-eve-jev)
guide for an end-to-end walkthrough.

## Runtime behavior

`auto` decides once per turn, before the first model call. The choice holds for the turn's later model calls, including in a fresh process. A new turn makes a new choice, and child sessions route from their own prompts.

The decider receives up to eight recent user and assistant text messages, capped at 16,000 characters. A request without user text, or with a latest message over the limit, fails before provider I/O.

Without `fallback`, a decider error fails the turn; with it, eve uses the fallback model for the rest of the turn. Cancelling the turn aborts the decision and keeps no routed or fallback choice. Validation, retries, provider errors, and model resolution follow AI SDK semantics.
