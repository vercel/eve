---
issue: TBD
status: implemented
last_updated: "2026-08-25"
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
agent.session                              {agent.session.id}
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
identity, action identity, and agent and framework identity. Message content, model output, and tool payloads are optional capture, off by
default. The OTel provider owns this mapping; the bridge and hooks contain no span names,
attributes, or parent contexts.

### The session root is a real span

`agent.session` is a real root span opened with OTel's `root` option, not a synthesized parent
context. Session planning allocates its identity and freezes admission before workflow startup. eve
persists that context, and later turns parent to the stored identity.

The native decision is authoritative for `agent.*` and AI SDK descendants. eve marks native OTel
context so the process sampler preserves the frozen decision; unrelated authored, request, and
auto-instrumented roots still delegate to the configured sampler unchanged.

### Marker spans

The session root is recorded and ended immediately, as `agent.turn` already is. A session outlives the
worker that opened it and a span object cannot cross that boundary, so eve records the root,
persists its span context, and parents later spans through it.

The cost is that a backend reports the root's duration rather than the window's. Turn and step
durations, where the time actually is, are unaffected, and `eve traces` renders a marker's
descendant extent in place of its zero duration.

A real duration would mean emitting the span once at session close, with explicit timestamps and a
span id chosen before the span exists. The ids are reachable — `registerOTel` accepts an
`idGenerator` — but the close is not: a session that goes idle and never resumes closes on nothing,
so its root would never be emitted and every span in the trace would reference a parent that never
arrives. A marker is the only representation that is always emitted. `agent.turn` does have a
guaranteed close and could carry a real duration; that is tracked separately.

### Subagents

A local subagent keeps its own session identity but inherits the parent action's instrumentation
decision and context, so delegated work appears directly beneath the action that caused it. Remote
dispatch sends `traceparent`; the receiver keeps an incoming unsampled decision and applies its local
policy as a veto to an incoming sampled decision. A child with no propagated context opens its own
root. `eve traces` resolves any session recorded in a trace, not only the one that opened it.

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

Legacy `defineInstrumentation()` and provider-directory layouts both adapt to the same serializable
session plan and bound control surface. Stream hooks and `step.started` semantics are unchanged.

## Delivery phases

1. **Lifecycle bridge.** — _landed._ Attempt scope, WeakMap state, typed hooks, before/after
   correlation, trusted context runner, AI SDK callback adapter.
2. **Per-attempt wiring.** — _landed._ One bridge per retry attempt through
   `telemetry.integrations`, composing authored OTel when active.
3. **Local OTel provider.** — _landed._ Lifecycle events mapped to the `agent.*` convention.
4. **Persistence.** — _landed._ OTLP/JSON segments, session context restored across dev worker
   restarts, retention bounds, capture policy.
5. **Inspection.** — _landed._ `eve traces ls` and `eve traces [trace]`.
6. **Session windows.** — _landed._ Real `agent.session` root with its recorded sampling
   decision, window rolling, subagent adoption, session-to-windows resolution in `eve traces`.
7. **Public providers.** — _landed._ Promote the lifecycle contract into public hooks and
   migrate OTel, Vercel, Braintrust, and custom instrumentation onto it.

## Acceptance criteria

- The lifecycle layer imports neither OTel nor AI SDK types. The harness-owned bridge maps AI SDK
  callbacks into eve-owned event payloads before providers observe them.
- Multiple providers observe one attempt while execution occurs exactly once.
- No provider definition receives model or tool execution functions.
- Documented authored instrumentation continues to observe eve calls.
- Each provider builds its trace without inheriting Workflow or another provider's trace.
- Native eve spans preserve the session decision; unrelated roots still use the authored sampler.
- A session of ordinary length is exactly one trace; a session of any length has bounded traces.
- `eve traces <session>` resolves every window of a session.
- Parallel tool calls retain independent provider state.
- Errors and aborts terminalize all started model and tool operations.
- Local traces contain no Workflow spans.
- Enabling local tracing does not change production instrumentation behavior.
