---
title: Automatic Model Selection
description: "Choose an agent model from the current request with an AI SDK evaluation model."
---

Use `autoModel` to choose an agent model from an allowlist before inference begins.
It uses the [AI SDK evaluation API](https://ai-sdk.dev/docs/ai-sdk-core/evaluation),
so the evaluator can be a Vercel AI Gateway model ID or an evaluation model from
an installed provider.

`eve/experimental/evaluate` is experimental. Its API can change between eve
releases, and the AI SDK evaluation model specification can change in patch
releases.

## Choose from Gateway models

By default, `autoModel` evaluates with `typesafe-ai/jev`. Like other AI SDK
model strings, it uses Vercel AI Gateway unless the application has configured a
different global default provider.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { autoModel } from "eve/experimental/evaluate";

export default defineAgent({
  model: autoModel({
    options: {
      "openai/gpt-5.6-sol": "Difficult reasoning and engineering tasks",
      "openai/gpt-5.6-luna": "Routine tasks where fast completion matters",
    },
  }),
});
```

Configure Gateway authentication as you would for any other AI SDK model. eve
does not add a TypeSafe credential or transport layer. During `eve dev`, a
Gateway evaluator uses the same connection selected through `/login` as Gateway
language models.

## Use a provider directly

Install the provider package yourself and pass its evaluation model. The provider
owns its credentials and settings.

```sh
pnpm add @ai-sdk/typesafe-ai
```

```ts title="agent/agent.ts"
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { defineAgent } from "eve";
import { autoModel } from "eve/experimental/evaluate";

export default defineAgent({
  model: autoModel({
    model: typeSafeAi.evaluationModel("jev-latest"),
    options: {
      "openai/gpt-5.6-sol": "Difficult reasoning and engineering tasks",
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
import { autoModel } from "eve/experimental/evaluate";

export default defineAgent({
  reasoning: "medium",
  model: autoModel({
    options: {
      "openai/gpt-5.6-sol": "Hard problems",
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

## Runtime behavior

`autoModel` evaluates at the first `step.started` event, after the incoming prompt
is available and before the selected language model runs. It reuses that choice
for later tool-loop steps in the same turn. A new turn makes a new choice, and
child sessions route from their own prompts.

The evaluator receives up to eight recent user and assistant text messages,
capped at 16,000 characters. Requests without user text and latest messages over
the limit fail before provider I/O.

Evaluation validation, retries, provider errors, and model resolution follow AI
SDK semantics. Cancelling the active turn aborts evaluation and prevents the
choice from being retained.
