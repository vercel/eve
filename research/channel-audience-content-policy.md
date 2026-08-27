---
issue: https://github.com/vercel/eve/issues/2331
status: proposed
last_updated: "2026-08-20"
---

# Audience-aware trace content policy

## Summary

Messaging agents need different trace behavior for public and private conversations. Public messages may be traced with model and tool content; private conversations should not produce traces unless an author explicitly admits them. Zero-config local tracing additionally retains unclassified HTTP/TUI sessions for debugging.

This proposal adds a fail-closed audience classification to channel instrumentation metadata, classifies built-in messaging channels from durable platform state, and separates the process-wide trace gate from each destination's ordered export pipeline.

## Channel contract

Channels may project one of three values from their existing synchronous `metadata(state)` callback:

```ts
type ChannelAudience = "public" | "private" | "unknown";
```

The field is optional for authored channels. Eve normalizes absent, malformed, and unsupported values to `unknown`. Built-in channel metadata interfaces require the field and classify only from platform evidence already captured during dispatch; ambiguous and proactive destinations remain `unknown` rather than performing observability-only network requests.

The normalized audience is persisted with session trace state and exported as `agent.channel.audience` only on each `agent.session` window. Durable Eve state and an internal OpenTelemetry context key make the same value available to descendant export policies without duplicating a public attribute onto every span. Local subagents inherit the parent audience. Remote agents classify their receiving channel independently rather than trusting opaque metadata across deployment boundaries.

## Public tracing API

This surface is available only when `experimental.instrumentationProviders` is enabled.

The process-wide declaration owns trace creation:

```ts
interface TraceCaptureContext {
  readonly agentName?: string;
  readonly audience: ChannelAudience;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

type TracePolicyDecision = "drop" | "metadata" | "inputs" | "outputs" | "content";

type TraceCapturePolicy = (trace: TraceCaptureContext) => TracePolicyDecision | boolean;

interface OtelOptions {
  // Other process-wide OTel settings are unchanged.
  readonly tracePolicy?: TraceCapturePolicy;
}

declare function otel(options?: OtelOptions): OtelDeclaration;
```

The trace decision is a process-wide ceiling. Each delivery is intersected with
its own audience classification, and destination capture settings may narrow it
further. A boolean return keeps the existing behavior: `false` drops trace
production, while `true` records content only where the audience ceiling permits.

Agent Runs and local traces expose the managed export policy:

```ts
interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly audience: ChannelAudience;
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
}

type SpanExportPredicate = (span: SpanExportContext) => boolean;

type SpanAttributeDecision =
  | { readonly action: "keep" }
  | { readonly action: "drop" }
  | {
      readonly action: "replace";
      readonly value:
        string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
    };

interface SpanExportPolicy {
  readonly span?: SpanExportPredicate;
  readonly attribute?: (input: {
    readonly key: string;
    readonly span: SpanExportContext;
    readonly value: unknown;
  }) => SpanAttributeDecision;
}

declare function redactSpanInputs(when?: SpanExportPredicate): SpanExportPolicy;
declare function redactSpanOutputs(when?: SpanExportPredicate): SpanExportPolicy;
declare function composeSpanExportPolicies(
  ...policies: readonly SpanExportPolicy[]
): SpanExportPolicy;

interface ManagedTraceOptions {
  readonly exportPolicy?: SpanExportPolicy;
  /** @deprecated Use redactSpanInputs() in exportPolicy. */
  readonly recordInputs?: boolean;
  /** @deprecated Use redactSpanOutputs() in exportPolicy. */
  readonly recordOutputs?: boolean;
}

declare function agentRuns(options?: ManagedTraceOptions): OtelIntegration;
declare function localTraces(options?: ManagedTraceOptions): OtelIntegration;
```

`redactSpanInputs()` removes known prompt, instruction, document, and tool-argument attributes from matching spans. `redactSpanOutputs()` removes known response, reasoning, embedding, ranking, and tool-result attributes, plus exception details, event attributes, and status messages. Neither mutates the shared OpenTelemetry span; each destination receives a filtered facade.

`composeSpanExportPolicies()` applies policies in declaration order. A later span or attribute policy sees the facade produced by earlier redactors. A span predicate returning `false` removes that span from one destination without suppressing the rest of its trace. Attribute policies run once for each attribute still visible at their stage.

For example, this retains every conversation while capturing content only for public audiences:

```ts
// agent/instrumentation/otel.ts
export default otel({
  tracePolicy: ({ audience }) => (audience === "public" ? "content" : "metadata"),
});

// agent/instrumentation/agent-runs.ts
export default agentRuns({
  exportPolicy: composeSpanExportPolicies({
    span: ({ name }) => name !== "internal.cache.refresh",
    attribute: ({ key }) =>
      key === "user.email" ? { action: "replace", value: "[redacted]" } : { action: "keep" },
  }),
});
```

## Defaults and ordering

The default authored and production head policy is equivalent to:

```ts
({ audience }) => audience === "public";
```

| Audience  | Trace created by default | Content when admitted by a custom trace policy |
| --------- | ------------------------ | ---------------------------------------------- |
| `public`  | Yes                      | Unchanged unless an export policy redacts it   |
| `private` | No                       | Unchanged unless an export policy redacts it   |
| `unknown` | No                       | Unchanged unless an export policy redacts it   |

The default policy for local tracing for `eve dev` is equivalent to:

```ts
({ audience }) => audience === "public" || audience === "unknown";
```

This keeps unclassified local HTTP/TUI sessions observable while still rejecting channels classified as `private`.

The runtime order is:

1. Derive and normalize the channel audience.
2. Evaluate the process-wide `tracePolicy` before creating `agent.session`.
3. For accepted traces, capture complete Eve and AI SDK spans.
4. Run each managed destination's composed export policies in declaration order. Custom integrations run their declared span processors.
5. Hand the resulting facade to that destination's processors or exporter.

There is no implicit content redaction after a custom trace policy admits an audience. Redaction occurs only when the export pipeline includes `redactSpanInputs()` or `redactSpanOutputs()` (or when a retained compatibility option explicitly requests the equivalent redaction).

Policies fail closed at their boundary: a throwing trace policy rejects the trace, a throwing span policy drops the span, a throwing attribute policy drops the attribute, and a throwing content-redaction predicate redacts that content direction. Missing, malformed, or conflicting audience evidence normalizes to `unknown`.

## Compatibility

The existing `recordInputs` and `recordOutputs` destination options remain accepted as deprecated source-compatible aliases. An explicit `false` prepends the corresponding redaction policy; these options no longer prevent accepted spans from capturing content upstream. `EVE_TRACES_CONTENT=off` similarly prepends both redactors for local traces.

Filtering remains a span-processor responsibility because local trace persistence and authored processors are processors rather than uniform exporters. Keeping the filtering boundary immediately above each destination prevents one destination's policy from mutating what another destination receives.
