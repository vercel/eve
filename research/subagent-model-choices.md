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

A list of Gateway slugs:

```ts title="agent/subagents/researcher/agent.ts"
import { defineAgent } from "eve";
import { choice } from "eve/models";

export default defineAgent({
  description: "Investigate ambiguous questions.",
  model: choice(["openai/gpt-6-luna", "openai/gpt-6-sol"]),
});
```

A mapping from slug to a description, or to `{ description, modelOptions }`:

```ts
model: choice({
  "openai/gpt-6-luna": "Routine lookups where speed matters",
  "openai/gpt-6-sol": {
    description: "Hard reasoning and engineering questions",
    modelOptions: { providerOptions: { gateway: { models: ["anthropic/claude-opus-5.5"] } } },
  },
});
```

List entries can mix slugs and objects. An object names its model with
`model`, which may also be a provider `LanguageModel`:

```ts
model: choice([
  { model: openai("gpt-6-luna-fast"), description: "Quick drafts" },
  "openai/gpt-6-sol",
]);
```

- The first entry is the default.
- The key the parent sends is the slug. For a `LanguageModel` it is the
  resolved Gateway slug, or `provider/modelId` when the catalog does not list it.
- Slugs must be unique.
- `modelOptions` applies to that choice only, so AI Gateway fallback composes
  with `choice` instead of competing with it.

## What the parent sees

The subagent's tool gains an optional `model` field:

```json
"model": {
  "type": "string",
  "enum": ["openai/gpt-6-luna", "openai/gpt-6-sol"],
  "default": "openai/gpt-6-luna",
  "description": "Model for a new agent. Defaults to openai/gpt-6-luna.\n- openai/gpt-6-luna: Routine lookups where speed matters\n- openai/gpt-6-sol: Hard reasoning and engineering questions"
}
```

`ctx.agent(name, { message, model })` accepts the same slugs, and
`ctx.agents[name].models` lists each slug with its description. The parent
never sees provider instances or `modelOptions`.

## Semantics

- The chosen entry is the child's session model for its whole lifetime. It is
  stored in the durable slot a `session.started` dynamic model fills, so model
  resolution, restart recovery, and compaction thresholds follow the existing
  dynamic-model path.
- `model` is rejected with `SUBAGENT_MODEL_INVALID` when the slug is unknown,
  when the target does not use `choice`, or when it comes with the `agentId` of
  an existing child.
- Context windows come from the Gateway catalog. A model the catalog does not
  list fails at build, as a static `model` without `modelContextWindowTokens`
  does today.
- `choice` is only valid on declared local subagents. A root agent has no caller
  to pick, so the compiler rejects it there. Dynamic subagent configs and
  `defineDynamic` resolvers must still return one static model. Remote
  subagents and the root-copy `agent` tool are unchanged.

## Data flow

```text
agent.ts model: choice(entries)
  -> manifest: default model + ordered choices { slug, description?, model ref }
  -> parent tool schema: model enum of slugs, default first
  -> dispatch validates the slug
  -> child runtime seeds the session model slot with the chosen reference
```

A `LanguageModel` entry compiles to a source-backed reference that the runtime
reloads from `agent.ts` by slug, the same way a direct static `model` reloads
today. The manifest keeps choices as data because the parent needs the slugs
and descriptions at build time to render its tool schema.

## Alternatives considered

- **`model: ["a", "b"]`.** Smallest change, but it reads like an AI Gateway
  fallback list ("try a, then b"), gives the parent no hint about when to pick
  each model, and blocks per-choice `modelOptions`.
- **`model: { choices: [...] }`.** Removes the fallback confusion, but adds a
  config shape that exists nowhere else and still carries no descriptions.
- **`defineDynamic`.** The author's resolver returns the decision. Here the
  decision belongs to the parent model, so a resolver has nothing to decide.
- **`choice({ options: { ... } })`.** Mirrors `auto` exactly, but the `options`
  wrapper is noise when the entries are the whole argument.

`choice(entries)` keeps the `auto` idea of described options under an
`eve/models` helper, drops the wrapper, and accepts a plain slug list for the
common case.
