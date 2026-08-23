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

At channel delivery, eve evaluates the process-wide trace policy and persists only its generic trace and content controls for that turn. The harness, lifecycle providers, trace state, and export policies never receive the audience classification. Local subagents inherit the resolved controls; remote agents classify their receiving channel independently.

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

type TraceCaptureDecision =
  | { readonly action: "drop" }
  | {
      readonly action: "record";
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

type TraceCapturePolicy = (trace: TraceCaptureContext) => TraceCaptureDecision;

interface OtelOptions {
  // Other process-wide OTel settings are unchanged.
  readonly tracePolicy?: TraceCapturePolicy;
}

declare function otel(options?: OtelOptions): OtelDeclaration;
```

Agent Runs and local traces expose the managed export policy:

```ts
interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
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

For example, this records public conversations with content and private conversations without content:

```ts
// agent/instrumentation/otel.ts
export default otel({
  tracePolicy: ({ audience }) =>
    audience === "public"
      ? { action: "record", recordInputs: true, recordOutputs: true }
      : audience === "private"
        ? { action: "record", recordInputs: false, recordOutputs: false }
        : { action: "drop" },
});

// agent/instrumentation/agent-runs.ts
export default agentRuns({
  exportPolicy: {
    span: ({ name }) => name !== "internal.cache.refresh",
    attribute: ({ key }) =>
      key === "user.email" ? { action: "replace", value: "[redacted]" } : { action: "keep" },
  },
});
```

## Defaults and ordering

The default authored and production head policy is equivalent to:

```ts
({ audience }) =>
  audience === "public"
    ? { action: "record", recordInputs: true, recordOutputs: true }
    : { action: "drop" };
```

| Audience  | Trace created by default | Input content | Output content |
| --------- | ------------------------ | ------------- | -------------- |
| `public`  | Yes                      | Yes           | Yes            |
| `private` | No                       | No            | No             |
| `unknown` | No                       | No            | No             |

The default policy for local tracing for `eve dev` is equivalent to:

```ts
({ audience }) =>
  audience === "public" || audience === "unknown"
    ? { action: "record", recordInputs: true, recordOutputs: true }
    : { action: "drop" };
```

This keeps unclassified local HTTP/TUI sessions observable while still rejecting channels classified as `private`.

The runtime order is:

1. Derive and normalize the channel audience at channel delivery.
2. Evaluate `tracePolicy` and persist only its drop/record and content controls for the turn.
3. Apply those controls to lifecycle providers, eve spans, and AI SDK telemetry before content is materialized.
4. Run each managed destination's composed export policies in declaration order. Destination policies may redact further but cannot restore content removed by the delivery controls.
5. Hand the resulting facade to that destination's processors or exporter.

Policies fail closed at their boundary: a throwing trace policy rejects the trace, a throwing span policy drops the span, a throwing attribute policy drops the attribute, and a throwing content-redaction predicate redacts that content direction. Missing, malformed, or conflicting audience evidence normalizes to `unknown`.

`traceChannelRequests` remains a separate opt-in request diagnostic. Its server span begins before channel delivery can classify audience and contains no body, session id, auth, cookie, token, or query content; the delivery decision governs the durable agent and AI trace beneath that request boundary.

## Compatibility

The existing `recordInputs` and `recordOutputs` destination options remain accepted as deprecated source-compatible aliases. An explicit `false` prepends the corresponding redaction policy. `EVE_TRACES_CONTENT=off` similarly prepends both redactors for local traces.

Boolean `tracePolicy` results are replaced by `TraceCaptureDecision`. This is a deliberate pre-1.0 API break: malformed results fail closed rather than being treated as an admission decision.
