---
issue: https://github.com/vercel/eve/issues/577
status: in-review
last_updated: "2026-07-07"
---

# Dynamic model resolution

## Summary

Tools, skills, and instructions can all be resolved dynamically per session or turn through
`defineDynamic`, with session, channel, and conversation context. The agent's model cannot: the
`model` field on `defineAgent` is evaluated once at compile time and frozen into the manifest. That
blocks routing cheap channels to a smaller model, picking a model per tenant from session auth,
escalating to a larger-context model as a conversation grows, and per-session A/B tests.

This plan extends the existing `model` field to accept the same `defineDynamic` sentinel used
everywhere else, with one addition: a required `fallback` model. The fallback is the compiled
static model, which keeps every compile-time surface (routing classification, gateway credential
checks, catalog context-window lookup, agent-info) working unchanged. The runtime seam already
exists — the harness resolves `session.agent.modelReference` immediately before every model call
(`harness/tool-loop.ts`) — so dynamic selection slots into the established dispatch → durable
context → tool-loop pipeline that dynamic instructions use today.

Implementation: vercel/eve#581.

## Authoring API

`model` becomes a union: a static value (unchanged) or `defineDynamic({ fallback, events })`.

```ts
// agent/agent.ts
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "session.started": (event, ctx) => {
        if (ctx.channel.kind === "slack") return "anthropic/claude-haiku-4.5";
        if (isEnterprise(ctx.session.auth)) return "anthropic/claude-opus-4.8";
        return null; // use the fallback
      },
    },
  }),
});
```

- `fallback` (required) is the build-time model: compiled metadata, compaction defaults, and the
  active model whenever no scoped selection is set.
- Handlers receive the standard `(event, ctx)` pair with the shared `DynamicResolveContext`
  (`session.id`, `session.auth`, `channel`, `messages`).
- Handlers return one of:
  - a gateway model id string (`"anthropic/claude-haiku-4.5"`);
  - a live AI SDK `LanguageModel` instance (`step.started` scope only);
  - a selection object `{ model, modelContextWindowTokens?, modelOptions? }`, mirroring the
    agent-level field names, for selections that need their own metadata;
  - `null` — leave this scope's slot unset.
- `defineDynamic` and the `DynamicResolveContext` type are exported from the root `eve`
  entrypoint, next to `defineAgent`.
- `compaction.model` stays static-only and rejects the sentinel with a dedicated error. When the
  primary model is dynamic, compaction falls back to the active selection exactly as it falls back
  to the static model today.

## Semantics

- **Events and scopes.** `session.started`, `turn.started`, and `step.started`. Precedence: step >
  turn > session > `fallback`; `null` leaves a scope unset so resolution falls through to the next
  scope. `session.started` is the documented default — model identity is almost always a function
  of session-stable facts, and **every model switch invalidates the provider prompt cache** (caches
  are per model). The docs carry an explicit warning that turn/step switching re-ingests the whole
  conversation at uncached prices on every flip.
- **Serialization boundary.** Session- and turn-scoped selections are stored durably (context keys
  `Session/TurnDynamicModelReferenceKey`) and must be serializable — a resolver returning a live
  provider instance from those scopes logs an error and leaves the scope unset. Live instances are
  step-scoped only: held in virtual (non-serialized) context and re-resolved every step, the same
  pattern as live step-scoped dynamic tools.
- **Degrade to fallback, never fail the turn.** A resolver that throws or returns an invalid
  selection logs an error and clears its scope; the turn proceeds on the next scope or `fallback`.
  This matches the dynamic tools/skills/instructions failure posture and is documented — a broken
  resolver silently serves the fallback, so resolvers backed by external services need monitoring.
- **Context window.** `modelContextWindowTokens` on a selection sets the compaction trigger for
  that scope. It is **never inherited from the fallback** — a different model's window is not a
  safe guess. A selection without it has no known window and the compaction threshold keeps using
  the last known window. The threshold rescales against the reference it was computed from (the
  session's current model reference), so repeated steps on one selection are idempotent, and
  clearing a selection restores the fallback-derived threshold.
- **Mocks keep precedence.** String selections are stored reference-only and resolve through
  `resolveRuntimeModelReference`, where the bootstrap and eval mock adapters short-circuit first.
  In mock mode (`NODE_ENV=test`, `EVE_MOCK_AUTHORED_MODELS=1`), live step-scoped instances are
  also stripped to reference-only so `eve eval` mock runs never hit real providers.
- **Static form unchanged.** `model: "anthropic/claude-sonnet-5"` and `model: anthropic(...)`
  compile, route, and resolve exactly as before. The TUI `/model` command rewrites only plain
  string literals; on a `defineDynamic` model it bails to the manual-edit path (it never rewrites
  the `fallback` literal).
- **Observability.** The `session.started` runtime identity reports a dynamic agent's model as
  `dynamic:<fallback id>` — per-scope selections happen after that identity is built. Build-time
  validation (routing, credentials, catalog) applies to the fallback only; a resolver can select a
  model the deployment has no credentials for, which fails at request time.

## Data flow

```text
compile   agent.ts model = defineDynamic({ fallback, events })
          ├─ manifest config.model  = compiled fallback (id, routing, window — unchanged path)
          └─ manifest config.dynamicModel = { eventNames, source ref to agent.ts }

boot      resolve-agent
          └─ dynamicModel source ref → RuntimeTurnAgent.dynamicModel

run       workflow-steps handleEvent (session.started / turn.started)
          └─ dispatchDynamicModelEvent → re-import agent.ts, run handler
              ├─ string / selection object → durable Session/TurnDynamicModelReferenceKey
              └─ live instance → error at these scopes (scope cleared)

step      tool-loop (before compaction and the model call)
          ├─ dispatch synthetic step.started → virtual LiveStepDynamicModelSelectionKey
          └─ getActiveDynamicModelSelection: step > turn > session > fallback
              ├─ live instance → used directly (stripped in mock mode)
              └─ reference → resolveModel (bootstrap/mock adapters first)
                  └─ session.agent.modelReference + compaction threshold updated per step
```

The updated session reference flows to the other consumers unchanged: web-search backend
selection, compaction model fallback, per-step `providerOptions`, and gateway attribution headers
derive from the active reference or the resolved model object.

## Out of scope

- Dynamic `compaction.model`.
- A runtime model catalog (context windows for dynamic selections come from the author).
- Per-selection routing/credential validation at build time.
- Remote subagents; local subagent nodes compile their own `agent.ts` and get dynamic models
  through the same path.

## Delivery and verification

Shipped in one PR (vercel/eve#581) with a patch changeset: shared types + normalization, compiler +
manifest (`config.dynamicModel`, schema v33), runtime resolver reattachment, dispatch lifecycle
(`context/dynamic-model-lifecycle.ts`), harness consumption, docs
(`docs/agent-config.md`, `docs/guides/dynamic-capabilities.md`), and tests:

- unit: lifecycle (scope pinning, precedence, null fallback, live-instance rejection at
  session/turn, mock-mode stripping, throwing resolvers, unknown-key selections), normalization
  (missing `fallback`, dynamic `compaction.model` rejection), compile (fallback compiled as the
  static model, resolver source preserved), harness (selection reaches the model call, compaction
  threshold stable across steps of one selection and restored when cleared), `/model` rewrite
  bails on `defineDynamic`.
- e2e: `e2e/fixtures/agent-model` evals — fallback turn with `dynamic:` runtime identity, per-turn
  selection plus null fallback in one session, and throwing-resolver degradation.
