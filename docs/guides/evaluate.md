---
title: Automatic Model Selection
description: "Choose agent models automatically or evaluate typed questions in your tools and application code."
---

Use `auto` from `eve/models` to choose an agent model from an allowlist before
inference begins. It uses the [AI SDK evaluation API](https://ai-sdk.dev/docs/ai-sdk-core/evaluation),
so the evaluator can be a Vercel AI Gateway model ID or an evaluation model from
an installed provider. Use `evaluate` from `eve/ai` to ask typed questions in
your own tools or application code.

The AI SDK evaluation model specification is experimental and can change in
patch releases.

## Choose from Gateway models

By default, `auto` evaluates with `typesafe-ai/jev`. Like other AI SDK
model strings, it uses Vercel AI Gateway unless the application has configured a
different global default provider.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-5.6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

Configure Gateway authentication as you would for any other AI SDK model. eve
does not add a TypeSafe credential or transport layer. During `eve dev`, a
Gateway evaluator uses the same connection selected through `/login` as Gateway
language models. A configured AI SDK default provider still owns string model
resolution during development. The TUI footer displays `dynamic model` when the
agent uses `auto`, then adds the resolved model for the current turn, such as
`dynamic model · openai/gpt-5.6-luna`.

## Use a provider directly

Install the provider package yourself and pass its evaluation model. The provider
owns its credentials and settings.

```sh
pnpm add @ai-sdk/typesafe-ai
```

```ts title="agent/agent.ts"
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    model: typeSafeAi.evaluationModel("jev-latest"),
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-5.6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

Any provider that implements the AI SDK `Experimental_EvaluationModel` contract
works here.

## Route to provider models and set reasoning

An option's key is the value shown to the evaluator. A string value describes a
Gateway model whose ID is the key. Use the object form when the selected model is
a provider instance, an alias, or needs a reasoning override.

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

The evaluator sees option keys, descriptions, and recent text messages. It never
receives provider credentials or serialized language model instances. When it
selects `my_secret_model`, eve resolves the key back to the authored Anthropic
model.

Supported reasoning values are `"provider-default"`, `"none"`, `"minimal"`,
`"low"`, `"medium"`, `"high"`, and `"xhigh"`. An omitted value inherits the
agent's reasoning setting.

## Evaluate inside a tool

Use `evaluate` to ask choice, score, or boolean questions about the state you pass to it.
It defaults to `typesafe-ai/jev` and uses the same authentication as `auto`,
including the Gateway connection selected through `/login` during `eve dev`.
Pass `model` to use another evaluation model ID or a provider instance. A configured
AI SDK default provider takes precedence over the local Gateway connection.

```ts title="agent/tools/classify-request.ts"
import { evaluate } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Choose the team that can help with a customer request.",
  inputSchema: z.object({ request: z.string().min(1).max(8000) }),
  async execute({ request }, ctx) {
    const result = await evaluate({
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
      abortSignal: ctx.abortSignal,
    });
    return { team: result.answers.team.choice };
  },
});
```

The choice above is typed as `"billing" | "support"`. Each question appears under
its authored key in `result.answers`. Results also include token usage, warnings,
provider metadata, and response metadata. To use that choice to delegate while keeping specialist subagents out of the parent model's tools, see [Route to a hidden subagent with JEV](/docs/tools/workflows#route-to-a-hidden-subagent-with-jev).

`evaluate` accepts AI SDK evaluation options, including `maxRetries`, `headers`,
and `providerOptions`. Pass an `abortSignal` to cancel the request. Input and
answer validation, retries, and provider errors follow AI SDK semantics.

You can also call `evaluate` outside a tool; it does not require an active eve
session. Each call performs its own evaluation. `auto` uses this function
and adds the per-turn routing behavior described below.

## Judge eval results

Eval authors can use `t.judge(...)` to turn evaluation answers into scored assertions, including batches of questions sharing one state. It uses this same `evaluate` implementation and default model. See [Judge](../evals/judge) for criteria, rubrics, and thresholds.

## Evaluate tool approvals

Use `auto({ model? })` when an evaluation model should decide whether a
tool call can run automatically or needs human approval. It accepts the same
AI SDK evaluation model strings and provider instances described above and
defaults to `typesafe-ai/jev`:

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

The evaluation model reviews the tool name and input for dangerous effects. A
caution, failed review, or incomplete input requires human approval. See
[Human-in-the-loop approvals](/docs/human-in-the-loop#approvals) for classifier
options and data handling.

## Runtime behavior

`auto` evaluates at the first `step.started` event, after the incoming prompt
is available and before the selected language model runs. It reuses that choice
for later tool-loop steps in the same turn. A new turn makes a new choice, and
child sessions route from their own prompts.

The evaluator receives up to eight recent user and assistant text messages,
capped at 16,000 characters. Requests without user text and latest messages over
the limit fail before provider I/O.

Evaluation validation, retries, provider errors, and model resolution follow AI
SDK semantics. Cancelling the active turn aborts evaluation and prevents the
choice from being retained.
