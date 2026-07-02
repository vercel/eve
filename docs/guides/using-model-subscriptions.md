---
title: "Using model subscriptions"
description: "Use a local Codex login as an eve model during development, and keep production on deployable model credentials."
---

This guide covers local account-backed model access, not deployable provider API
credentials. Today, eve exposes that path for Codex through the
`experimental_codex` model value, which uses local Codex login state during
development.

## Use a local Codex login

Pass the bare OpenAI model slug to `experimental_codex` and assign the result
to `model`. It is not a delegated tool or an MCP connection — it selects the
model and changes the local development transport.

Sign in with the Codex CLI first:

```bash
codex login
```

Then set the model in `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent, experimental_codex } from "eve";

export default defineAgent({
  model: experimental_codex("gpt-5.5"),
});
```

eve reads Codex login state from `~/.codex/auth.json` before starting a Codex
model turn. It does not accept or expose token values through the eve config
surface. ChatGPT-authenticated Codex requests use the Codex Responses backend;
API-key-authenticated requests use the OpenAI Responses API.

The adapter uses AI SDK's OpenAI Responses model implementation, so AI SDK
function tools stay in the normal eve tool loop. eve keeps execution, approval,
connections, and durable history in charge for those tools.

Codex subscription mode does not use AI Gateway model metadata to validate model
availability or context windows. Set `modelContextWindowTokens` when you want
eve's compaction threshold to match the selected model's context window.

## Production boundary

Production builds never use the local Codex login. eve optimistically keeps the
model on its normal AI Gateway route — `openai/gpt-5.5` for the example above —
when the gateway model catalog confirms that id, so deployment uses deployable
model credentials rather than a developer's local Codex login.

When the catalog does not confirm the id (for example, a Codex-only model),
the production build uses the fallback model you pass as the second argument:

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent, experimental_codex } from "eve";

export default defineAgent({
  model: experimental_codex("gpt-5.5-codex", anthropic("claude-sonnet-4.6")),
});
```

Without a fallback, a production build whose OpenAI id the catalog cannot
confirm fails with a compile error. Setting `modelContextWindowTokens` skips
the catalog lookup entirely and always keeps the `openai/<model>` gateway
route in production.

Codex use is governed by OpenAI's current [Terms of Use](https://openai.com/policies/terms-of-use/),
[Service Terms](https://openai.com/policies/service-terms/), and
[Usage Policies](https://openai.com/policies/usage-policies/); confirm your
deployment and account usage fit those terms before running Codex-backed models
outside local development.
