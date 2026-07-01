---
title: "Using model subscriptions"
description: "Use a local Codex login as an eve model during development, and keep production on deployable model credentials."
---

This guide covers local account-backed model access, not deployable provider API
credentials. Today, eve exposes that path for Codex through
`experimental.useCodexSubscription`, which uses local Codex login state during development.

## Use a local Codex login

Keep `model` as the OpenAI model id you want to use, then opt into local Codex
auth with `experimental.useCodexSubscription`. The string selects the model; the
experimental flag changes the local development transport. It is not a
delegated tool or an MCP connection.

Sign in with the Codex CLI first:

```bash
codex login
```

Then enable the local Codex transport in `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.5",
  experimental: {
    useCodexSubscription: true,
  },
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

Production builds do not apply the local Codex auth transform. The same
`model: "openai/..."` string compiles as the normal AI Gateway/provider route
for production, so deployment uses deployable model credentials rather than a
developer's local Codex login.

Codex use is governed by OpenAI's current [Terms of Use](https://openai.com/policies/terms-of-use/),
[Service Terms](https://openai.com/policies/service-terms/), and
[Usage Policies](https://openai.com/policies/usage-policies/); confirm your
deployment and account usage fit those terms before running Codex-backed models
outside local development.
