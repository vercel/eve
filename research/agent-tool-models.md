---
issue: TBD
status: proposed
last_updated: "2026-11-05"
---

# Model choice on the `agent` tool

## Decision

Replace `agentWithModel` with an optional `models` setting on the root `agent`
tool. The author declares the models a root-copy task may use, and the parent
model picks one by key. A key maps to an AI Gateway model ID or a live AI SDK
`LanguageModel`, in the same option shape as `auto()` from `eve/models`.

```ts
// agent/tools/agent.ts
import { agent } from "eve/tools/agent";
import { anthropic } from "@ai-sdk/anthropic";

export default agent({
  models: {
    "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
    "openai/gpt-6-luna": "Routine tasks where fast completion matters",
    haiku: {
      model: anthropic("claude-haiku-5"),
      description: "Cheap lookups and short summaries",
      reasoning: "low",
    },
  },
});
```

`agentWithModel` is removed before 1.0. It has two problems this design fixes:

- It works only with AI Gateway model IDs, because the model-facing input is a
  free-form string that must cross the durable workflow boundary.
- It does not tell the parent model which models exist, so the parent guesses
  a model ID and the author cannot limit the choice.

## Semantics

### Without `models`

`export { default } from "eve/tools/agent"`, `agent`, and `agent()` behave like
today's default tool. The model-facing schema has no `model` property, and the
child inherits the current model. The parent model never sees a model option.

"Inherits the current model" means the child opens with no model override, so
it resolves the root agent's own model configuration. For a static model, that
is the parent's model. For a dynamic model such as `auto()`, the child runs the
same resolver on its own turns, so `auto()` routes on the delegated message.

### With `models`

- The model-facing input is `{ message, model?, taskId? }`. `model` is an enum
  of the declared keys, and each key's description reaches the parent model
  through the schema.
- When a call omits `model`, the child inherits the current model, as it does
  without `models`.
- A task keeps the model it started with. A continuation may omit `model`; a
  continuation that names a different key fails, as `agentWithModel` does today.
- Only the declared keys are accepted. An unknown key is a validation error, so
  the parent model can never select a model the author did not list.

### Option shape

`models` uses the `auto()` option record:

```ts
type AgentModelOption =
  | string // description; the key is the AI Gateway model ID
  | {
      readonly model: string | LanguageModel;
      readonly description: string;
      readonly reasoning?: AgentReasoningDefinition;
      readonly modelContextWindowTokens?: number;
      readonly modelOptions?: AgentModelOptionsDefinition;
    };
```

A record, not a list, because the parent model needs a description to choose
well, and a `LanguageModel` instance needs a stable key to survive the durable
boundary (see below). The same record can be passed to `auto({ options })` and
`agent({ models })`.

### Subagents never get this tool

A tool with `models` lets a model choose which model, and so which cost and
capability tier, runs a copy of the root agent. That decision stays with the
root session. The configured tool is always `availableInSubagents: false`, and
the setting cannot be overridden. Subagent sessions keep the model their own
configuration resolves.

## Design

### Shared model options

Move the option type, validation, and selection normalization out of
`packages/eve/src/models/auto.ts` into a shared `#models/options.ts`. `auto()`
and `agent({ models })` both use it, so the two APIs accept and reject the same
inputs. This step does not change behavior.

### Callable `agent`

`agent` is a stamped tool definition today. Make it a stamped function: the
bare export still compiles as the default tool, and calling it returns a
configured tool. Calling it without `models` returns the default tool.

The configured tool is a workflow tool. Its serve body is today's
`agentWithModelServeWorkflow`, changed to resolve a key into a selection
instead of taking a free-form string.

### Crossing the durable boundary

A live `LanguageModel` cannot be serialized into the child workflow, which is
why the `ctx.agent` model override accepts only Gateway IDs
([ctx-agent-model-override](./ctx-agent-model-override.md)).

The child therefore receives the key, not the model:

- A Gateway string option can still travel inline as a normal serializable
  `AgentSessionModelSelection`.
- An instance option travels as a source-backed runtime model reference: the
  tool export's module source plus the option key. The child loads the tool
  export from its compiled module map and reads the option, the same way
  `resolveRuntimeModelReference` already loads authored models through
  `source` and `sourceField`.

The child persists the reference before session creation, so replay opens the
same model. If a deployment removes the key, the task fails with a clear
error, like `auto()` does for a removed option.

`ctx.agent(name, { model })` keeps its serializable public shape. The key
reference is an internal path for the agent tool only.

### Model-facing schema

Generate the schema from the declared keys:

```json
{
  "type": "object",
  "properties": {
    "message": { "type": "string" },
    "model": {
      "type": "string",
      "enum": ["openai/gpt-6-sol", "openai/gpt-6-luna", "haiku"],
      "description": "Model for a new task. Omit to use the current model. ..."
    }
  },
  "required": ["message"],
  "additionalProperties": false
}
```

The per-key descriptions go in the `model` description (or in `oneOf` entries
with `const` and `description` where providers accept them).

## Plan

1. Move the shared model options out of `auto.ts`, with no behavior change.
2. Make `agent` callable and add `models`, with the generated schema and the
   key-to-selection serve body.
3. Add the source-backed key reference so instance options survive replay.
4. Remove `agentWithModel` and `AgentWithModelTool`. Update
   `public-api/eve/tools/agent.json`, `docs/subagents/index.mdx`,
   `docs/concepts/built-in-tools.md`, the `agent-subagents` e2e fixture, and
   [ctx-agent-model-override](./ctx-agent-model-override.md). Add a changeset
   with the migration:
   `agentWithModel` → `agent({ models: { "<gateway-id>": "<when to use it>" } })`.

## Validation

- Unit: option validation is shared with `auto()`; the schema has no `model`
  property without `models`; the enum and descriptions match the declared keys.
- Workflow: a key resolves to its selection; an omitted `model` inherits the
  current model; a continuation keeps its model and rejects a different key; a
  removed key fails the task.
- Integration: a `LanguageModel` instance option survives workflow replay.
- Subagent sessions never receive the configured tool.

## Deferred: pin the parent's resolved model

Pinning the child to the exact model the parent resolved for the current turn
differs from the above only when the root model is dynamic. It is deferred
because it needs two things that do not exist today:

- The serve workflow cannot see the parent's resolved model. Workflow tool
  context exposes no current-model value.
- A dynamic resolver can return a live `LanguageModel`, and durable model
  selections reject provider objects. Pinning it would need a source-backed
  reference to the resolver's choice, such as the memoized `auto()` option key.

Reconsider it if routing the child again with `auto()` proves wrong in practice.
