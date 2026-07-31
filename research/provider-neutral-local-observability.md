---
issue: TBD
status: in-progress
last_updated: "2026-07-30"
---

# Provider-neutral local observability

## Summary

eve produces local traces without depending on Workflow tracing, changing production
instrumentation, or coupling observability providers to the AI SDK. The first consumer is
zero-config tracing in `eve dev`; the lifecycle contract must also support OTel, Vercel,
Braintrust, and custom providers.

```text
eve lifecycle boundaries ------------------+
                                            +--> eve lifecycle hooks --> providers
AI SDK callbacks -> per-attempt bridge -----+       (local OTel, Vercel, Braintrust, custom)
AI SDK execute() -> eve-owned context runner
```

## Lifecycle contract

```ts
createAiSdkHookBridge(scope, hooks, runInContext): Telemetry;

interface InstrumentationHooks {
  publish(event: InstrumentationPointEvent): Promise<void>;
  before(name: "model.call" | "tool.call", event: StartEvent): Promise<void>;
  after(name: "model.call" | "tool.call", event: TerminalEvent): Promise<void>;
}
```

The bridge is an adapter, not a provider. It maps AI SDK callbacks into eve-owned lifecycle
events, assigns stable attempt/model-call/tool-call identities, terminalizes open operations on
error and abort, and invokes the trusted `runInContext` while calling execution exactly once. AI
SDK `callId` values are bridge correlation details, not provider run identities.

The bridge does not create spans, export records, apply capture policy, or publish durable
eve-native events. Session, turn, compaction, suspension, and canonical step-terminal events are
published by the harness.

Attempt state is WeakMap-keyed by scope identity so abandoned attempts do not leak. `before` state
is retained per provider and operation and supplied only to that provider's `after`.

## Providers

A provider is a hook definition: handlers for the eve-owned events it cares about. An OTel provider
may return spans from `before` and close them in `after`; Braintrust may retain row handles; Vercel
may enqueue records.

Each provider owns an independent trace graph, rooted from its own serializable session state — not
from ambient Workflow context or another provider's active context.

Providers never receive an execution function. A built-in integration needing ambient context may
register a trusted internal `runInContext` alongside its event definition; that is not part of the
provider contract.

## Local tracing

In `eve dev` eve registers the process tracer provider (`registerOTel`) with a private span
processor consuming the same lifecycle events as any other provider, so nested AI SDK and user
spans share agent context. It creates one trace per session window, explicitly roots that window
rather than inheriting the ambient Workflow span, drops spans from the `workflow` instrumentation
scope, and persists OTLP/JSON segments under `.eve/traces/v1`.

Those immutable segments are the canonical local store. A future index or dashboard is a
rebuildable consumer of the spool, not a second source of trace identity.

Authored instrumentation and local capture may observe the same attempt without executing the model
or tool more than once.

## Agent OTel semantics

```text
agent.session                              {agent.session.id, agent.session.window}
  +-- agent.turn                           {agent.turn.id, agent.turn.sequence}
      +-- agent.step                       {agent.step.index, agent.step.attempt}
          +-- model-provider spans
          +-- agent.action                 {agent.action.kind, name, call_id}
              +-- tool-provider spans
```

GenAI spans stay nested implementation detail; they do not define the agent run. An `agent.step`
covers one model call and the actions it requests through their resolution. `agent.action.kind` is
an open discriminator — `tool` today, with `skill`, `subagent`, and `remote-agent` reserved.

The `agent.*` namespace carries cheap structural attributes only: session/turn/step/attempt
identity, action identity, agent and framework identity, channel and environment, principal, and
parent/root lineage. Message content, model output, and tool payloads are optional capture, off by
default. The OTel provider owns this mapping; the bridge and hooks contain no span names,
attributes, or parent contexts.

### Session windows

A session is one trace until it outgrows one. Sessions run for thousands of turns across days, and a
single unbounded trace serves nobody: the local store evicts whole traces, and exporters cap spans
per trace and assemble within a bounded time window, so late children get dropped. No local session
is long enough to reach that, so windowing is for the production providers of phase 7; it is settled
here because the window is what a subagent adopts and what a sampler decides on.

A session therefore maps to a sequence of windowed traces. A window rolls on a turn count, chosen so
ordinary sessions stay exactly one trace, and rolls only between turns so a turn's spans always
share a trace. Turn count is the sole criterion because it is derived from state eve already
persists, so a replaying worker reaches the same decision — an elapsed-time rule could not.
`agent.session.window` is the zero-based index; each window's root records
`agent.session.window.previous.trace.id`.

Session identity does not live in the trace id. Every span carries `agent.session.id`, and eve's
inspection path resolves a session to its windows through that attribute.

### The window root is a real span

`agent.session` is a real root span opened with OTel's `root` option, not a synthesized parent
context. eve persists its span context — including the sampling decision it actually received — and
later turns in the window parent to that stored context.

This is what makes an authored sampler work. A synthesized parent asserting a sampled flag is a
valid parent to `ParentBasedSampler`, which resolves through a parent branch and never consults the
configured root rule. Asserting unsampled instead selects `localParentNotSampled`, which drops
everything. A genuine root avoids both.

Sampling is therefore per window, not per session: a ratio sampler may keep some windows of a long
session and drop others. `agent.session.id` is a creation-time attribute, so an author who needs
whole sessions can key a sampler on it.

### Marker spans

The window root is recorded and ended immediately, as `agent.turn` already is. A window outlives the
worker that opened it and a span object cannot cross that boundary, so eve records the root,
persists its span context, and parents later spans through it.

The cost is that a backend reports the root's duration rather than the window's. Turn and step
durations, where the time actually is, are unaffected, and `eve traces` renders a marker's
descendant extent in place of its zero duration.

A real duration would mean emitting the span once at window close, with explicit timestamps and a
span id chosen before the span exists. The ids are reachable — `registerOTel` accepts an
`idGenerator` — but the close is not: a session that goes idle and never resumes closes on nothing,
so its root would never be emitted and every span in the trace would reference a parent that never
arrives. A marker is the only representation that is always emitted. `agent.turn` does have a
guaranteed close and could carry a real duration; that is tracked separately.

Cross-window grouping relies on `agent.session.id` plus the previous-trace-id chain. Span links are
the richer form but are not in eve's vendored OTel surface. Vercel Agent Runs is assembled from
Workflow run tags rather than spans and is unaffected.

### Subagents

A subagent keeps its own session identity but records into the window its parent had open, so
delegated work appears in the trace that caused it. Durable trace state is scoped to one session's
context, so the window's `SpanContext` is handed down at dispatch rather than looked up by the
child, and the child snapshots it — a later roll on the parent does not move work already recorded.
A child with no handed-down window (a remote agent, running under its own deployment's tracing)
opens its own root. A child that outgrows the adopted window rolls into its own, chained like any
other roll. `eve traces` resolves any session recorded in a trace, not only the one that opened it.

## Runtime integration

```text
runModelCallWithRetries(attempt)
  -> create stable AttemptScope
  -> createAiSdkHookBridge(scope, hooks, runInContext)
  -> telemetry.integrations = [bridge, authoredOtel?]
```

The harness supplies session id, turn id, logical step index, and retry attempt index. The bridge
derives model/tool identities at their start callbacks and keeps callback snapshots in
invocation-local state; `onStepEnd` and `onEnd` only snapshot, and the harness publishes the
canonical terminal after durable actions are emitted. On replay the harness recreates attempt state;
only provider-owned serializable context crosses Workflow boundaries.

AI SDK `onStepStart` is named `attempt.started` because it begins one concrete model attempt, so
retries have distinct starts and terminals without overloading the stream's `step.started`.

Per-call integrations replace the AI SDK global list; eve composes the bridge with `@ai-sdk/otel`
when the documented `instrumentation.ts` path is active. Direct `registerTelemetry()` calls are not
a supported customization surface. Braintrust's documented integration uses eve hooks and
`defineInstrumentation`, so per-call injection does not disable it.

## Compatibility

Production keeps its current `defineInstrumentation` and `@ai-sdk/otel` behavior until provider
migration ships. Without lifecycle hooks no bridge is installed and production follows the existing
authored path unchanged. Stream hooks and `step.started` semantics are unchanged.

## Delivery phases

1. **Lifecycle bridge.** — _landed._ Attempt scope, WeakMap state, typed hooks, before/after
   correlation, trusted context runner, AI SDK callback adapter.
2. **Per-attempt wiring.** — _landed._ One bridge per retry attempt through
   `telemetry.integrations`, composing authored OTel when active.
3. **Local OTel provider.** — _landed._ Lifecycle events mapped to the `agent.*` convention.
4. **Persistence.** — _landed._ OTLP/JSON segments, session context restored across dev worker
   restarts, retention bounds, capture policy.
5. **Inspection.** — _landed._ `eve traces ls` and `eve traces [trace]`.
6. **Session windows.** — _in review._ Real `agent.session` root with its recorded sampling
   decision, window rolling, subagent adoption, session-to-windows resolution in `eve traces`.
7. **Public providers.** — _not started._ Promote the lifecycle contract into public hooks and
   migrate OTel, Vercel, Braintrust, and custom instrumentation onto it.

## Acceptance criteria

- The lifecycle layer imports no OTel types. It does derive AI SDK callback payload shapes from
  `Telemetry`, so `attempt`, `model.call`, and `tool.call` events currently expose AI SDK types to
  providers — a known deviation from provider neutrality, to close in phase 7.
- Multiple providers observe one attempt while execution occurs exactly once.
- No provider definition receives model or tool execution functions.
- Documented authored instrumentation continues to observe eve calls.
- Each provider builds its trace without inheriting Workflow or another provider's trace.
- No eve span inherits a synthesized parent, so an authored sampler's root rule is consulted.
- A session of ordinary length is exactly one trace; a session of any length has bounded traces.
- `eve traces <session>` resolves every window of a session.
- Parallel tool calls retain independent provider state.
- Errors and aborts terminalize all started model and tool operations.
- Local traces contain no Workflow spans.
- Enabling local tracing does not change production instrumentation behavior.
