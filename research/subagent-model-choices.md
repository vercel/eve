---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: proposed
last_updated: "2026-09-24"
---

# Subagent model choices

## Problem

A declared subagent pins one model. When a parent wants a fast model for
routine work and a stronger one for hard work, it has to declare the same
subagent twice.

The parent already knows which kind of work it is delegating. It writes the
message, so it can also say which model should handle it.

## Authoring API

`choice` from `eve/models` lists the models a caller may pick when it starts a
child. The first entry is the default.

```ts title="agent/subagents/researcher/agent.ts"
import { defineAgent } from "eve";
import { choice } from "eve/models";

export default defineAgent({
  description: "Investigate ambiguous questions.",
  model: choice(["openai/gpt-6-luna", "openai/gpt-6-sol"]),
});
```

Describe entries to tell the caller when to pick each one, and attach
per-choice `modelOptions`:

```ts
model: choice({
  "openai/gpt-6-luna": "Routine lookups where speed matters",
  "openai/gpt-6-sol": {
    description: "Hard reasoning and engineering questions",
    modelOptions: { providerOptions: { gateway: { models: ["anthropic/claude-opus-5.5"] } } },
  },
});
```

A list can mix slugs and objects. An object names its model with `model`,
which may also be a provider `LanguageModel`:

```ts
model: choice([
  { model: openai("gpt-6-luna-fast"), description: "Quick drafts" },
  "openai/gpt-6-sol",
]);
```

The caller sends the slug: the Gateway slug for a string, and the resolved
catalog slug (or `provider/modelId`) for a `LanguageModel`. Slugs must be
unique.

## What the caller sees

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
`ctx.agents[name].models` lists them with their descriptions. Provider
instances and `modelOptions` never reach the caller.

## Semantics

- The pick is made once, when the child starts, and holds for its lifetime.
  eve stores it in the same durable slot a `session.started` dynamic model
  fills, so model resolution, restart recovery, and compaction follow the
  existing path.
- `model` is rejected with `SUBAGENT_MODEL_INVALID` when the slug is not
  listed, when the target does not use `choice`, or when it comes with the
  `agentId` of an existing child.
- Context windows come from the Gateway catalog. A model the catalog does not
  list fails at build.
- `choice` works only on declared local subagents. The compiler rejects it on a
  root agent, which has no caller to pick. Dynamic subagent configs must still
  return one model. Remote subagents and the root-copy `agent` tool are
  unchanged.

## Questions this design answers

**Why not `model: ["a", "b"]`?** It reads like an AI Gateway fallback list:
try `a`, then `b`. It also has nowhere to put descriptions or per-choice
`modelOptions`. `choice` names the intent, and Gateway fallback still works
inside each entry's `modelOptions`.

**Why not `defineDynamic`?** A dynamic resolver is the author's code returning
the decision. Here the decision belongs to the caller, so a resolver would
have nothing to decide. `choice` reuses the runtime half of dynamic models
(the durable session slot) without the resolver.

**Why not let `auto` pick?** `auto` sends the question to a separate
evaluation model: another network round trip, judging from recent text. The
parent is already making the tool call and has the whole task in front of it,
so it can pick for free and with more context. `choice` borrows `auto`'s
option shape, not its classifier.

**Won't the parent always pick the strongest model?** It might. Descriptions
and a sensible first entry steer it, and the author bounds the cost: a model
that should never be picked does not belong in the list.

**What about callers that are not models?** Authored workflow code passes
`model` or omits it and gets the first entry. A root agent has no caller at
all, which is why the compiler rejects `choice` there.

**Why fix the model for the child's lifetime?** A delegation is scoped when it
starts. Switching models mid-task would change behavior under the parent's
feet and invalidate the context window the child compacts against. A caller
that wants another model starts another child.

## Data flow

```text
agent.ts model: choice(entries)
  -> manifest: default model + ordered choices { slug, description?, model ref }
  -> caller tool schema: model enum of slugs, default first
  -> dispatch validates the slug
  -> child runtime seeds the session model slot with the chosen reference
```

A `LanguageModel` entry compiles to a source-backed reference that the runtime
reloads from `agent.ts` by slug, as a direct static `model` does today. The
manifest keeps choices as data because the caller's tool schema needs the slugs
and descriptions at build time.
