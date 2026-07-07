---
issue: https://github.com/vercel/eve/issues/577
status: proposed
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
everywhere else. The runtime seam already exists — the harness resolves
`session.agent.modelReference` once per step, immediately before every model call
(`harness/tool-loop.ts`) — so dynamic resolution slots into the established dispatch → durable
context → tool-loop pipeline that dynamic instructions use today.

## Authoring API

`model` becomes a union: a static value (unchanged) or a `defineDynamic({ events })` sentinel.

```ts
// agent/agent.ts
import { defineAgent, defineDynamic, defineModel } from "eve";
import { anthropic } from "@ai-sdk/anthropic";

export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": () => "anthropic/claude-sonnet-5",
      "turn.started": (event, ctx) => {
        if (ctx.channel.kind === "slack") return "anthropic/claude-haiku-4.5";
        if (needsDeepReasoning(ctx.messages)) return anthropic("claude-opus-4-8");
        if (isHugeContext(ctx.messages))
          return defineModel({
            model: "google/gemini-3-pro",
            contextWindowTokens: 1_000_000,
            providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
          });
        return null; // keep the session-scope choice
      },
    },
  }),
});
```

- Handlers receive the standard `(event, ctx)` pair with the shared `DynamicResolveContext`
  (`session.id`, `session.auth`, `channel`, `messages`).
- Handlers return one of:
  - a gateway model id string (`"anthropic/claude-haiku-4.5"`);
  - a live AI SDK `LanguageModel` instance;
  - `defineModel({ model, contextWindowTokens?, providerOptions? })` — the branded entry form,
    where `model` is a gateway id or a live instance;
  - `null` — leave this scope's slot unchanged.
- `defineModel` and `defineDynamic` are exported from the root `eve` entrypoint, next to
  `defineAgent`. A `DynamicModelEvents` type gives authoring-time return checking, mirroring
  `DynamicToolEvents`.
- `compaction.model` stays static-only. When the primary model is dynamic, compaction falls back to
  the active dynamic reference exactly as it falls back to the static model today.

## Semantics

- **Events.** `session.started` and `turn.started` only, enforced like
  `ALLOWED_DYNAMIC_INSTRUCTION_EVENTS`. The model is stable within a turn: it is the most
  cache-sensitive input to the wire format, and a mid-turn switch would also scramble turn-level
  telemetry and compaction accounting.
- **Precedence.** Turn result overrides session result. `null` keeps the current slot, so a
  `turn.started` handler that returns `null` falls back to the `session.started` choice.
- **No silent default.** A dynamic `model` has no static fallback. If no scope has produced a model
  when the first step needs one (all handlers returned `null`, or a handler threw), the turn fails
  with an error naming the agent config and the events that ran. Pre-1.0 we prefer a loud failure
  over an invisible default model.
- **Scope stability.** A resolved model is pinned for its scope. Serializable results (gateway id
  strings and string-backed `defineModel` entries) are pinned durably and survive workflow replay
  without re-invoking the handler — a non-deterministic resolver (per-session A/B) cannot flip
  mid-scope. Live-instance results cannot cross a step boundary; they are pinned in-process and the
  resolver is re-invoked after replay (park/resume). Live-instance resolvers must therefore be
  deterministic per scope; this is documented, matching the inline-`execute` replay constraint on
  dynamic tools.
- **Context window.** A dynamic reference has no compile-time catalog lookup.
  `defineModel({ contextWindowTokens })` sets the compaction trigger for that scope; otherwise the
  authored `modelContextWindowTokens` applies; otherwise the token-based compaction trigger is
  inactive, as today for unknown models. Docs recommend setting one of the two when switching
  between models with different windows.
- **Mocks first.** The bootstrap and eval mock-model short-circuits in
  `resolveRuntimeModelReference` keep precedence over dynamic resolution, so `eve eval` mock mode
  stays deterministic.
- **Static form unchanged.** `model: "anthropic/claude-sonnet-5"` and `model: anthropic(...)`
  compile, route, and resolve exactly as before, including catalog-derived context windows and the
  TUI `/model` rewrite. `/model` detects a dynamic config and reports that it cannot rewrite it.

## Data flow

```text
compile   agent.ts model = DynamicSentinel
          └─ manifest model ref { id: "dynamic", dynamic: true, source, routing: { kind: "dynamic" } }

boot      resolve-agent
          └─ re-import agent.ts from the module map, reattach events → dynamicModelResolver

run       workflow-steps handleEvent (session.started / turn.started)
          └─ dispatchDynamicModelEvent
              ├─ string / defineModel(string) → durable Session/TurnDynamicModelKey { id, ... }
              └─ live instance → virtual live key + durable { live: true } marker

step      tool-loop model resolution
          └─ getActiveDynamicModel(ctx): turn > session; re-invoke resolver on live marker
              └─ resolveModel(active ?? session.agent.modelReference)
```

The active reference also feeds the other `session.agent.modelReference` consumers: web-search
backend selection, compaction fallback, and per-step `providerOptions`. Gateway attribution headers
and prompt-cache path detection already derive from the resolved model object and need no change.

## Compile-time surface

- `normalizeAgentDefinition` accepts the sentinel for `model` (validating event names and handler
  functions) and rejects it under `compaction.model`.
- `ModelRouting` gains `{ kind: "dynamic" }`. Credential checks (`info.ts`,
  `resolve-model-endpoint-status.ts`, TUI setup issues) treat it as gateway-credentials-recommended,
  since string results route through the gateway; agent-info passes it through.
- The compiled reference stores the agent-config `source` ref (the mechanism source-backed static
  instances already use), so runtime can reattach handlers with no emitted code.

## Out of scope

- Dynamic `compaction.model`.
- A `step.started` event (mid-turn switching).
- A runtime model catalog (context windows for dynamic references come from the author).
- Subagent-specific behavior: each node's `agent.ts` compiles independently, so subagents get
  dynamic models for free through the same path.

## Delivery and verification

One PR with a patch changeset:

1. Types + `defineModel` + root exports; normalization; compiler + manifest schema + routing
   consumers.
2. `runtime/resolve-dynamic-model.ts`, `context/dynamic-model-lifecycle.ts`, dispatch wiring in
   `execution/workflow-steps.ts`, harness consumption in `tool-loop.ts` / `tools.ts` /
   `compaction.ts` / `step-hooks.ts`.
3. Docs: `docs/agent-config.md` model section and `docs/guides/dynamic-capabilities.md` gain the
   model capability, its events, and the live-instance determinism note.

Tests:

- unit: `dynamic-model-lifecycle.test.ts` mirroring `dynamic-instruction-lifecycle.test.ts`
  (pinning, precedence, null, unbranded and throwing resolvers, live marker after replay);
  `core.test.ts` normalization; `normalize-agent-config` compile cases; `tool-loop.test.ts` cases
  asserting the override reference reaches `resolveModel`, provider tools, and compaction; the
  no-model-resolved failure.
- e2e: a fixture eval (new `e2e/fixtures/agent-model`) proving a `turn.started` switch between two
  real models based on channel metadata, deterministic and self-contained beyond model-provider
  credentials.

Run the repository's required unit, integration, scenario, typecheck, lint, format, invariant,
docs, and build checks.
