---
title: "Using model subscriptions"
description: "Use a local Codex login as an eve model during development, and keep production on deployable model credentials."
---

This guide covers local account-backed model access, not deployable provider API
credentials. Today, eve exposes that path for Codex through `experimentalCodex`,
which uses local Codex login state instead of an API key in `agent.ts`.

## Use a local Codex login

`experimentalCodex` selects a Codex model backed by local Codex login state. It
is not a delegated tool or an MCP connection.

Sign in with the Codex CLI first:

```bash
codex login
```

Then use `experimentalCodex` for local runs and a deployable model route for
production:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { experimentalCodex } from "eve/codex";

const model =
  process.env.NODE_ENV === "production"
    ? "openai/gpt-5.5"
    : experimentalCodex({
        model: "gpt-5.5",
      });

export default defineAgent({
  model,
});
```

eve reads Codex login state from `~/.codex/auth.json` before starting a Codex
model turn. It does not accept or expose token values through the eve config
surface. ChatGPT-authenticated Codex requests use the Codex Responses backend;
API-key-authenticated requests use the OpenAI Responses API.

The adapter uses AI SDK's OpenAI Responses model implementation, so AI SDK
function tools stay in the normal eve tool loop. eve keeps execution, approval,
connections, and durable history in charge for those tools.

If eve cannot resolve context-window metadata for the selected Codex model, set
`modelContextWindowTokens` to the model's documented context window.

## Production boundary

Production deployments should use a deployable model route such as an AI Gateway
string model id or provider-owned API credentials, not a developer's local Codex
login. Codex use is governed by OpenAI's current [Terms of Use](https://openai.com/policies/terms-of-use/),
[Service Terms](https://openai.com/policies/service-terms/), and
[Usage Policies](https://openai.com/policies/usage-policies/); confirm your
deployment and account usage fit those terms before running Codex-backed models
outside local development.
