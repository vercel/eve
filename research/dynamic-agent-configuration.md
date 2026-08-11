---
issue: "1945"
status: proposed
last_updated: "2026-08-11"
---

# Dynamic agent configuration without fallbacks or placeholders

## Decision

Reimplement dynamic model and dynamic subagent configuration around one rule:
the compiler stores either a concrete value or a resolver, never both.

- `defineDynamic` is resolver-only: `defineDynamic({ events })`.
- A dynamic model handler must return a concrete model selection. It cannot
  return `null` or `undefined`, and it has no fallback.
- Dynamic tools, skills, instructions, and subagents may return `null` to omit
  a capability.
- A dynamic model has no compiled model reference. The selected model becomes
  concrete at runtime before model-dependent work begins.
- A dynamic subagent has no compiled agent config or placeholder model. Its
  filesystem resources compile independently, and its handler supplies the
  concrete config before a child session starts.
- Root dynamic models and dynamically selected subagent configs share runtime
  model normalization and AI Gateway metadata lookup.

`DEFAULT_AGENT_MODEL_ID` remains the product default used by `eve init`, the
setup model picker, and agents with no `agent.ts`. It is not an internal
placeholder. The bootstrap model remains limited to the framework-owned
bootstrap runtime.

## Authoring API

The default choice belongs in the model handler:

```ts
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        if (ctx.messages.some(isLargeContextRequest)) {
          return "anthropic/claude-opus-4.1";
        }

        return "openai/gpt-5.5";
      },
    },
  }),
});
```

A dynamic model handler returns a model ID, a live AI SDK model, or
`{ model, modelContextWindowTokens?, modelOptions? }`. Runtime validation still
rejects `null`, `undefined`, malformed results, and unknown keys. When context
metadata is omitted, eve resolves it from AI Gateway at selection time.
Dynamic agents cannot set sibling `modelContextWindowTokens` or `modelOptions`
fields because those would become implicit selection defaults.

A dynamic subagent returns a concrete `defineAgent`, a concrete
`defineRemoteAgent`, or `null`:

```ts
import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!shouldOfferResearcher(ctx)) return null;

      return defineAgent({
        description: "Research the request.",
        model: "openai/gpt-5.5",
      });
    },
  },
});
```

A returned local config must use a static model. Build-only configuration
stays on the outer dynamic definition or another static compile input.

## Compiled ownership

Compiled root config and subagent nodes use mutually exclusive unions:

```ts
type CompiledAgentModelConfig =
  | { readonly model: CompiledRuntimeModelReference; readonly dynamicModel?: never }
  | { readonly model?: never; readonly dynamicModel: CompiledDynamicModelResolver };

type CompiledSubagentNode = CompiledSubagentNodeBase &
  (
    | { readonly config: CompiledAgentConfig; readonly configResolver?: never }
    | { readonly config?: never; readonly configResolver: CompiledDynamicSubagentResolver }
  ) & {
    readonly resources: CompiledAgentResources;
  };
```

The exact manifest layout may remain flattened. Its TypeScript and Zod shapes
must still enforce that filesystem resources compile independently from agent
execution config. Dynamic nodes contain no `DEFAULT_AGENT_MODEL_ID`, synthetic
`"dynamic"` model ID, bootstrap model, or hidden default.

Inspection uses the same invariant: static model data contains an ID and
static routing; unresolved dynamic model data contains only a dynamic routing
discriminator.

## Runtime resolution and caching

One runtime-owned operation normalizes root model selections, selected local
subagent models, and explicit compaction models in selected subagent configs.
It validates live models, serializes provider options, normalizes provider IDs,
and produces a serializable runtime reference with the resolved model ID and
metadata.

Successful runtime catalog metadata is cached in durable workflow state for 24
hours. Gateway models are keyed by normalized gateway ID; provider models are
keyed by provider and provider model ID. Writes remove expired entries. Failed
requests and missing models are never cached, and transport or authentication
failures remain distinct from a missing-model result. A full catalog response
may remain execution-local, but only metadata for selected models is durable.

Dynamic model scope precedence is:

```text
step selection > turn selection > session selection
```

Session and turn selections are durable and therefore accept only serializable
model IDs. A step selection lasts for one model call and may carry a live
provider object. The harness requires an active selection before compaction,
prompt caching, model-dependent tool preparation, or a provider call.

A selected dynamic subagent config is normalized and persisted before child
dispatch. The child combines that config with compiled resources and does not
repeat catalog lookup.

## Events and failures

Session identity and model-call identity are separate. `session.started`
identifies the agent, eve version, deployment, and source revision. It does not
invent a model for an unresolved dynamic agent. The concrete model ID is
reported on the public `step.started` event after dynamic selection and before
model-dependent work.

- A dynamic model handler that returns `null` or `undefined` fails the turn.
- A malformed selection fails before model-dependent work.
- An unknown model without explicit context metadata produces an actionable
  metadata error.
- Catalog authentication and transport failures propagate and are not cached.
- A dynamic subagent may return `null` to omit itself.
- A dynamic subagent resolver exception or malformed selected config follows
  the existing capability policy: log the failure and omit the subagent.

## Compatibility and validation

This is an intentional pre-1.0 breaking change. Remove the fallback overload,
fallback generics, and fallback runtime guards. Bump the compiled manifest
version. Publish new dynamic tool, skill, and instruction contract epochs while
retaining older executable epochs. Bump and drop the affected hook epochs when
model identity moves from session runtime metadata to step attribution. Add a
minor changeset.

Coverage must include public type rejection, exact unions and schemas, scope
precedence, durable live-object rejection, shared normalization, metadata-cache
hits and expiry, provider aliases, request errors without negative caching,
placeholder-free manifests, dynamic subagent resource compilation, inspection
output, subprocess build/boot coverage, deterministic failure behavior, and
real-model catalog resolution and reuse.

## Invariants

- A model ID always names a concrete provider model.
- `"dynamic"` is a discriminator, never a model ID.
- A dynamic model has no reference until a handler selects one.
- A dynamic local subagent has no execution config until a handler selects one.
- `DEFAULT_AGENT_MODEL_ID` is a product default, not a compiler escape hatch.
- Every model call has one normalized concrete model reference before any
  model-dependent work.
- Runtime-derived metadata is durable, serializable, TTL-bounded, and cached
  only after successful lookup.
- TypeScript and runtime schemas enforce identical static and dynamic variants.
- Missing selections, resolver failures, stale manifests, and inspection
  surfaces contain no hidden fallback behavior.
