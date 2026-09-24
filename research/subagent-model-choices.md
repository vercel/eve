---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: proposed
last_updated: "2026-09-24"
---

# Subagent model choices

## Problem

A declared subagent pins one model. A parent that wants a fast model for
routine work and a stronger one for hard work has to declare the same subagent
twice.

## Authoring API

`choice` from `eve/models` lets the caller pick a declared subagent's model
when it starts a child. It mirrors `auto`: `auto` asks an evaluation model to
pick; `choice` hands the pick to the parent.

```ts title="agent/subagents/researcher/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";
import { choice } from "eve/models";

export default defineAgent({
  description: "Investigate ambiguous questions.",
  model: choice({
    options: {
      "openai/gpt-6-luna": "Routine lookups where speed matters",
      "openai/gpt-6-sol": "Hard reasoning and engineering questions",
      careful_anthropic: {
        model: anthropic("sonnet-5"),
        description: "Long documents that need careful reading",
        reasoning: "low",
      },
    },
  }),
});
```

Options use the `auto` option shape:

- A string value describes the Gateway model whose id is the key.
- `{ model, description, reasoning? }` selects a Gateway id or a provider
  `LanguageModel` under any key, with an optional reasoning override.
- The first key is the default.

## What the parent sees

The subagent's tool gains an optional `model` field:

```json
"model": {
  "type": "string",
  "enum": ["openai/gpt-6-luna", "openai/gpt-6-sol", "careful_anthropic"],
  "default": "openai/gpt-6-luna",
  "description": "Model for a new agent. Defaults to openai/gpt-6-luna. openai/gpt-6-luna: Routine lookups where speed matters. ..."
}
```

`ctx.agent(name, { message, model })` accepts the same keys, and
`ctx.agents[name].models` maps each key to its description. Like `auto`, the
parent only sees keys and descriptions, never provider instances.

## Semantics

- The chosen option is the child's session model for its whole lifetime. It is
  stored in the durable slot a `session.started` dynamic model fills, so model
  resolution, restart recovery, and compaction thresholds follow the existing
  dynamic-model path.
- `model` is rejected with `SUBAGENT_MODEL_INVALID` when the key is unknown,
  when the target does not use `choice`, or when it comes with the `agentId` of
  an existing child.
- Context windows come from the Gateway catalog. A provider model the catalog
  does not know fails at build, as a static `model` does today.
- `choice` is only valid on declared local subagents. A root agent has no caller
  to pick, so the compiler rejects it there. Dynamic subagent configs and
  `defineDynamic` resolvers must still return one static model. Remote
  subagents and the root-copy `agent` tool are unchanged.
- `choice` is not a fallback list. Gateway fallback stays in `modelOptions`.

## Data flow

```text
agent.ts model: choice({ options })
  -> manifest: default model + ordered options { key, description, reasoning?, model ref }
  -> parent tool schema: model enum of keys, default first key
  -> dispatch validates the key
  -> child runtime seeds the session model slot with the chosen reference
```

A `LanguageModel` option compiles to a source-backed reference that the runtime
reloads from `agent.ts` by key, the same way a direct static `model` reloads
today. The manifest keeps options as data because the parent needs the keys
and descriptions at build time to render its tool schema.
