---
issue: TBD
status: proposed
last_updated: "2026-07-24"
---

# Provider-neutral local observability

## Summary

eve should produce useful local traces without depending on Workflow tracing, changing production
instrumentation, or coupling observability providers directly to the AI SDK.

The first consumer is zero-config tracing in `eve dev`, but the lifecycle contract must support
OTel, Vercel, Braintrust, and custom providers.

## Desired flow

```text
eve lifecycle boundaries -------------------+
                                             +--> eve lifecycle hooks
AI SDK callbacks -> per-attempt bridge -------+            |
                                                          +--> local OTel provider
AI SDK execute() -> eve-owned context runner              +--> Vercel provider
                                                          +--> Braintrust provider
                                                          +--> custom providers
```

The AI SDK bridge is an adapter, not an instrumentation provider. It translates AI SDK callbacks
into immutable, eve-owned lifecycle events.

Providers never receive raw AI SDK event types or execution functions.

## Lifecycle contract

The bridge receives stable attempt scope and typed lifecycle hooks:

```ts
createAiSdkHookBridge(scope, hooks, runInContext): Telemetry;
```

```ts
interface LifecycleHooks {
  publish(event: LifecycleEvent): Promise<void>;

  before(name: "model.call", event: ModelCallStartedEvent): Promise<void>;
  after(name: "model.call", event: ModelCallTerminalEvent): Promise<void>;

  before(name: "tool.call", event: ToolCallStartedEvent): Promise<void>;
  after(name: "tool.call", event: ToolCallTerminalEvent): Promise<void>;
}
```

Lifecycle events use eve-owned identities and payloads. AI SDK `callId` values are bridge
correlation details, not provider run identities.

Related `before` state is retained per provider and operation, then supplied only to that
provider's `after`. Attempt state is scoped by object identity and WeakMap-backed so abandoned
attempts do not leak state.

## Bridge responsibilities

The bridge:

- snapshots AI SDK callbacks;
- maps them into eve-owned lifecycle events;
- assigns stable attempt, model-call, and tool-call identities;
- publishes starts and terminals through typed hooks;
- terminalizes open operations on errors and aborts;
- invokes trusted `runInContext` with a typed model or tool operation while calling execution
  exactly once.

The bridge does not create spans, export records, apply provider capture policy, or publish durable
eve-native events.

Session, turn, compaction, suspension, and canonical step-terminal events are published directly
by the eve harness.

## Provider responsibilities

Providers are ordinary lifecycle hook definitions. Each provider subscribes by defining handlers
only for the eve-owned events it cares about; the lifecycle dispatcher invokes those handlers when
the corresponding boundaries occur.

An OTel provider may return spans from `before` and close them in `after`. Braintrust may retain
native row handles. Vercel may enqueue normalized records.

Each provider owns an independent trace graph. It creates or restores its root from provider-owned,
serializable session state and derives later parentage from that state. Providers do not use ambient
Workflow context, or another provider's active context, as their trace parent.

Providers never receive an execution function. A built-in integration that needs ambient context
may register a trusted internal `runInContext` alongside its event definition; it is passed directly
to the bridge and is not part of the provider or hook contract.

## Local tracing

`eve dev` registers a private local OTel provider that consumes the same lifecycle events as other
providers.

The local provider:

- is registered privately by eve while using the process OTel runtime so nested user spans share
  agent context;
- creates one trace per eve session, independently from Workflow context;
- explicitly roots session context instead of inheriting the ambient Workflow span;
- never captures Workflow spans;
- persists traces as OTLP/JSON for later inspection.

Authored instrumentation and local capture may observe the same attempt concurrently without
executing the model or tool more than once.

## Agent OTel semantics

The local OTel provider emits an agent-first structural convention. GenAI spans may remain nested
implementation detail, but they do not define the agent run.

```text
session trace                              {agent.session.id}
  +-- agent.turn                           {agent.turn.id, agent.turn.sequence}
      +-- agent.step                       {agent.step.index, agent.step.attempt}
          +-- model-provider spans
          +-- agent.action                 {agent.action.kind, name, call_id}
              +-- tool-provider spans
```

The session is the trace, not a long-lived span. All turns share its trace id. Session lifecycle
events attach to the turn that causes the transition; a transition without a turn may use a
zero-duration marker span.

An `agent.step` covers one model call and the actions it requests through their resolution.
`agent.action.kind` is an open discriminator for `tool`, `skill`, `subagent`, and `remote-agent`.
Subagents use their own session trace and link back to the calling action.

The `agent.*` namespace contains cheap structural attributes: session, turn, step and attempt
identity; action identity; agent/framework identity; channel and environment; principal; and
parent/root lineage. Message content, model output, tool arguments, and tool results are optional
capture, off by default.

The OTel provider owns this mapping. The AI SDK bridge and lifecycle hooks do not contain OTel span
names, attributes, or parent contexts.

## Runtime integration

The bridge is injected per actual model attempt:

```text
runModelCallWithRetries(attempt)
  -> create stable AttemptScope
  -> createAiSdkHookBridge(scope, hooks, runInContext)
  -> telemetry.integrations = [bridge, authoredOtel?]
  -> AI SDK invokes callbacks and trusted runInContext
```

The harness supplies `sessionId`, `turnId`, logical step index, and retry attempt index. The bridge
derives stable model/tool identities once at their start callbacks and stores callback snapshots in
invocation-local attempt state. `onStepEnd` and `onEnd` only snapshot results; the harness later
publishes the canonical terminal event after durable actions are emitted. On replay, the harness
recreates this attempt state; only provider-owned serializable context crosses Workflow boundaries.

The existing eve stream keeps its current `step.started` boundary. AI SDK `onStepStart` is named
`attempt.started` in the instrumentation lifecycle because it begins one concrete model attempt;
retries and recovery calls therefore have distinct starts and terminals without introducing a
second meaning for `step.started`.

AI SDK per-call integrations replace its global list. eve explicitly composes the bridge with its
known `@ai-sdk/otel` adapter when the documented `instrumentation.ts` OTel path is active. Direct
AI SDK `registerTelemetry()` calls are not part of eve's supported customization surface.

Braintrust's documented eve integration uses eve hooks and `defineInstrumentation`, so per-call
bridge injection does not disable it.

## Compatibility

Production keeps its current `defineInstrumentation` and `@ai-sdk/otel` behavior until provider
migration is explicitly shipped.

Without lifecycle hooks, no bridge override is present and production follows its existing authored
instrumentation path unchanged.

Existing stream hooks and current `step.started` semantics remain unchanged during the initial
local-tracing work.

## Delivery phases

1. **Lifecycle bridge.** Land the unused attempt scope, WeakMap-backed state, typed hooks, related
   before/after correlation, a trusted context runner, and the AI SDK callback adapter. No
   runtime wiring.
2. **Per-attempt wiring.** Add optional internal lifecycle hooks to the harness and pass one bridge
   through `telemetry.integrations` per retry attempt, composing authored OTel when active. No
   provider or trace output yet.
3. **Local OTel provider.** Add a private provider that maps lifecycle events to the `agent.*`
   convention and proves the trace tree in memory. Production remains unchanged.
4. **Persistence.** Write session traces as OTLP/JSON, restore provider-owned session context across
   dev worker restarts, and apply payload capture policy. No browser UI.
5. **Inspection.** Add minimal `eve trace ls` and `eve trace show` commands. A graphical viewer is a
   separate design after the trace model stabilizes.
6. **Public providers.** Promote the proven lifecycle contract into public hooks and migrate OTel,
   Vercel, Braintrust, and custom instrumentation onto it.

The current bridge PR is phase 1 only: it lands unused primitives and cannot emit a trace.

## Acceptance criteria

- The provider-neutral lifecycle layer imports no AI SDK or OTel types.
- Multiple providers observe one attempt while execution occurs exactly once.
- No provider definition receives model or tool execution functions.
- Documented authored instrumentation continues to observe eve calls.
- Each eve provider can build its trace without inheriting Workflow or another provider's trace.
- Parallel tool calls retain independent provider state.
- Errors and aborts terminalize all started model and tool operations.
- Local traces contain no Workflow spans.
- Enabling local tracing does not change production instrumentation behavior.
