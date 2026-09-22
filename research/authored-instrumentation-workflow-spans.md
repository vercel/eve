---
issue: https://github.com/vercel/eve/issues/1779
status: proposed
last_updated: "2026-08-07"
---

# Suppress Workflow spans in authored instrumentation

## Summary

`agent/instrumentation.ts` can export agent, model, and tool spans to any
OpenTelemetry backend, but it cannot exclude the Workflow SDK's own
`workflow`-scoped spans. Those spans dominate the exported trace and usually
become its displayed root, so an agent-focused trace reads as a workflow
trace with agent spans buried inside it.

`instrumentations: []` does not help: it disables auto-instrumentation
(HTTP/fetch), while the Workflow spans are created manually through
`trace.getTracer("workflow")`.

This document proposes a `traceWorkflowSpans` option on
`defineInstrumentation` and the one interposition point where eve can
honor it.

## Problem

eve's zero-config local trace writer already solves this. It owns the whole
pipeline in `eve dev`, so `AgentTraceSpanProcessor` simply refuses spans whose
instrumentation scope is `workflow` before they reach the local writer.

Authored instrumentation inverts that ownership:

```text
eve dev (no instrumentation.ts)        agent/instrumentation.ts
  eve calls registerOTel                 author calls registerOTel
  eve owns the span processors           author owns the span processors
  → filter at export                     → eve has no export-time seam
```

`registerInstrumentationConfig` invokes the authored `setup(...)`; everything
downstream — provider, sampler, processors, exporter — belongs to the author.
eve never wraps a user-registered tracer provider today, and it cannot reach
the author's processors to filter spans on the way out.

The scope name is stable across the SDK: `@workflow/core`,
`@workflow/world-local`, and `@workflow/world-vercel` all call
`trace.getTracer("workflow")`, so one scope predicate covers every Workflow
span an agent can emit.

## Proposed API

```ts
export default defineInstrumentation({
  traceWorkflowSpans: false,
  setup: ({ agentName }) => {
    registerOTel({
      serviceName: agentName,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
  },
});
```

- `true` (default): Workflow spans are exported alongside agent spans —
  today's behavior, unchanged.
- `false`: no span from the `workflow` instrumentation scope is created, so
  none reaches the author's exporter.

The option is read once, after `setup` returns. It is inert when there is no
authored `instrumentation.ts`, because the zero-config local writer already
drops these spans.

## Mechanism

`@opentelemetry/api` always registers a single `ProxyTracerProvider` on
`globalThis[Symbol.for("opentelemetry.js.api.1")]` and resolves every
`trace.getTracer(...)` call through it. eve can therefore install a
scope-filtering delegate immediately after the author registers theirs,
without owning the registration:

```text
registerInstrumentationConfig(config, { agentName })
  1. config.setup(context)                 → author's registerOTel(...) registers a provider
  2. traceWorkflowSpans === false          → wrap the proxy's delegate:
       getTracer("workflow") → no-op tracer
       getTracer(other)      → author's provider
  3. store config on globalThis
```

Three properties make this workable:

- The proxy is shared across module instances. eve's vendored
  `@opentelemetry/api` and the author's copy resolve the same global object,
  so a delegate eve installs is visible to the Workflow SDK and vice versa.
- The delegate is consulted per `getTracer` call, so the swap applies to
  tracers resolved later.
- Every Workflow package resolves its tracer lazily, on the first span it
  emits — after startup plugins have run. The swap therefore lands before the
  first Workflow span exists.

That last point is an ordering invariant, not a coincidence: the
instrumentation plugin must run before the Workflow world is constructed.
`createApplicationNitroPlugins` already guarantees it, and the invariant needs
a test that fails loudly if plugin order changes.

A no-op tracer — not a processor-less provider — is the right filter. It emits
nothing, and its spans carry the _parent's_ span context, so children re-parent
onto the nearest surviving ancestor instead of pointing at a span the backend
never received.

## Observable semantics

With `traceChannelRequests: true` and a Workflow-driven turn:

```text
traceWorkflowSpans: true (default)     traceWorkflowSpans: false
POST /eve/v1/session/:sessionId        POST /eve/v1/session/:sessionId
  └── workflow.execute                   └── ai.eve.turn
        └── step.execute                       └── ai.streamText
              └── ai.eve.turn
                    └── ai.streamText
```

The trace id is unchanged and no span is orphaned; the Workflow layer is
elided and its children are promoted.

When a Workflow span _is_ the outermost span — the common case in production,
where inbound request spans are off by default — the trace is rooted at
`ai.eve.turn` with a fresh trace id. This is the intended outcome, and it does
not fragment traces that are whole today: the Workflow SDK defaults to
`WORKFLOW_TRACE_MODE=linked`, which already produces one bounded trace per
invocation rather than one trace per run.

Two consequences are worth documenting rather than engineering around:

- In `linked` mode the run-origin span link lives on the Workflow invocation
  span. Suppressing that span drops the link, so per-invocation traces no
  longer point back to the run origin. Agents that navigate traces this way
  should keep the default.
- In `continuous` mode the extracted origin context stays valid, so agent
  spans attach to the origin trace and continuity is preserved.

## Boundaries

`traceWorkflowSpans` governs OpenTelemetry span _emission_ only. It is
independent of, and must not change:

- `traceChannelRequests` — the inbound `SERVER` span is eve-scoped
  (`eve.channel`) and unaffected.
- `$eve.*` Workflow run tags — framework-owned run metadata, not spans.
- Vercel Agent Runs observability — driven by those run tags.
- Local traces in `eve dev` — already exclude the `workflow` scope, and are
  replaced wholesale by an authored `instrumentation.ts`.

## Alternatives considered

**Export-time filtering, mirroring `AgentTraceSpanProcessor`.** Semantically
ideal: spans stay recording, trace ids and context propagation are untouched,
and only export is suppressed. Rejected because it requires reaching into the
author's provider for its private active span processor. Wrapping the tracer
so the underlying span is never `end()`ed reaches the same result by leaving
spans permanently open, which is worse.

**A processor-less `BasicTracerProvider` for the `workflow` scope.** Keeps the
trace id but leaves every promoted child pointing at a `parentSpanId` the
backend never receives. Also pulls `@opentelemetry/sdk-trace-base` into the
runtime for no benefit over a no-op tracer.

**A scope-aware sampler.** `Sampler.shouldSample` receives no instrumentation
scope, and the sampler belongs to the author's provider. A `RECORD`-but-not-
sampled decision would additionally suppress descendant agent spans under the
default parent-based sampler.

**An exported `excludeWorkflowSpans(processor)` helper the author composes.**
Precise, needs no global surgery, and would be the natural shape if eve owned
no interposition point. Rejected as the primary API because it only works for
authors who wire their processors through it, and the issue's declarative flag
matches how `recordInputs`, `recordOutputs`, and `traceChannelRequests`
already read. Worth revisiting if provider surgery proves fragile.

## Risks

- eve begins mutating a tracer provider it does not own. The wrapper must
  delegate faithfully for every other scope and must no-op when no provider
  was registered (an authored `setup` that skips OTel entirely).
- A Workflow package that resolves and caches its tracer during module
  evaluation rather than on first span would defeat the swap. The behavior is
  version-dependent and needs a regression test pinned against the vendored
  Workflow version.
- The vendored `@opentelemetry/api` declaration is a hand-written subset and
  does not yet describe `trace.getTracerProvider()` or the proxy's
  delegate accessors; it must grow the minimal surface this needs.

## Validation

- Unit: the wrapper returns a non-recording tracer for `workflow` and the
  author's tracer for every other scope; `true` and the unset default install
  no wrapper; a missing provider is tolerated.
- Unit: `registerInstrumentationConfig` applies suppression only after
  `setup` returns.
- Integration: with an in-memory exporter, a nested
  `eve.channel` → `workflow` → `eve` span tree exports the agent spans
  re-parented onto the channel span, with the trace id preserved and no
  dangling parent.
- Scenario: plugin ordering — the instrumentation plugin is registered before
  the Workflow world is constructed.
- E2E: extend the `agent-workflow-stress` fixture, the only fixture with an
  authored `instrumentation.ts`, so a real deployment exercises the disabled
  path.
- Docs: `docs/guides/instrumentation.md` gains the option next to
  `traceChannelRequests`, including the run-origin link caveat.
