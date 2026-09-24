---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: implemented
last_updated: "2026-09-24"
---

# Subagent model choices

## Problem

A declared subagent pins one model. A parent that wants a cheap model for easy
work and a stronger one for hard work has to declare the same subagent twice.

## Authoring API

`model` in `defineAgent` accepts a Gateway model id string or a non-empty array
of them. The first entry is the default.

```ts title="agent/subagents/researcher/agent.ts"
export default defineAgent({
  description: "Investigate ambiguous questions.",
  model: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5.5"],
});
```

The declared subagent tool, and `ctx.agent()`, accept an optional `model`:

```ts
{ message: string; agentId?: string; model?: string; outputSchema?: object }
```

The tool schema lists the choices as an `enum` with the first entry as its
`default`. Subagents without an array keep the existing schema.
Authored workflow tools read the same list from `ctx.agents[name].models`.

## Semantics

An array lowers to `session.started` dynamic model semantics:

- The caller's choice, or the first entry, is the child's session model for its
  whole lifetime. It is stored in the same durable slot a `session.started`
  resolver fills, so model resolution, restart recovery, and compaction
  thresholds follow the existing dynamic-model path.
- `model` is rejected with `SUBAGENT_MODEL_INVALID` when it is not listed, when
  the target has no choices, or when it comes with the `agentId` of an existing
  child.
- Each entry must resolve through the Gateway catalog. Sibling
  `modelContextWindowTokens` and `modelOptions` are rejected.
- Root agents use the first entry; nothing selects another one. Dynamic
  subagent configs and `defineDynamic` resolvers must return one static model.
  Remote subagents and the root-copy `agent` tool are unchanged.

## Data flow

```text
agent.ts model: [a, b]
  -> manifest: model = a, modelChoices = [a, b]
  -> parent tool schema: model enum [a, b], default a
  -> dispatch validates model
  -> child runtime seeds the session model slot with the chosen reference
```

The compiled manifest keeps the list as data rather than a synthesized
`defineDynamic` module, because the parent needs the ids at build time to
render the tool schema.
