---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: implemented
last_updated: "2026-09-20"
---

# Instrumentation classification

## Summary

Add one optional `classificationPolicy` to the instrumentation graph. Authors
declare it from any `defineInstrumentation()` file. eve evaluates it before
trace policies and before provider records, then carries the result through
provider-neutral instrumentation context.

Lifecycle handlers receive the result as `ctx.classification`. OpenTelemetry
adapters project the same result onto spans, and destination `exportPolicy`
callbacks receive it as `SpanExportContext.classification`. Destinations do
not declare another classifier: `agentRuns()`, `localTraces()`, and
`otelIntegration()` keep their existing options.

```text
channel metadata + classification state
                 |
                 v
        classificationPolicy
          |             |
          v             v
 tracePolicy       record classification
                         |
              +----------+----------+
              |                     |
              v                     v
   ProviderContext.classification   OTel context
                                          |
                                          v
                              SpanExportContext.classification
```

Only one registered instrumentation provider may declare
`classificationPolicy`. More than one declaration is a startup error. This
keeps one trace or record classification available to every instrumentation
adapter without defining merge or precedence semantics.

## Channel evidence

The originating channel owns the trace-level classification evidence. Existing
`metadata(state)` remains the ordinary observability projection.
`classificationState(state)` selects additional JSON state that the classifier
may inspect.

```ts
import type { JsonValue } from "eve/instrumentation";

export interface InstrumentationPropertyBag {
  readonly [key: string]: JsonValue;
}

export interface GenericChannelDefinition<TState = undefined> {
  // Existing channel fields are unchanged.

  readonly classificationState?: (state: NonNullable<TState>) => Readonly<Record<string, unknown>>;
}

export interface UnclassifiedTraceCaptureContext {
  readonly agentName: string;
  readonly audience: ChannelAudience;
  readonly channel: {
    readonly kind: InstrumentationChannelKind;
    readonly name?: string;
    readonly metadata?: InstrumentationPropertyBag;
    readonly state?: InstrumentationPropertyBag;
  };
  readonly environment: "development" | "preview" | "production";
  readonly mode: RunMode;
  readonly principalType: string;
}
```

eve validates `classificationState` as JSON before classification. An omitted
hook contributes no channel state. eve does not fall back to the complete
adapter state or expose the channel's runtime `context()` value.

## Classification contract

The policy classifies two boundaries:

- `trace` receives channel and conversation context before trace policy
  evaluation.
- `record` receives the provider-neutral lifecycle event after the trace
  content ceiling has removed declined inputs or outputs.

```ts
export interface ClassificationPolicyContext {
  readonly abortSignal: AbortSignal;
}

export interface TraceClassificationInput {
  readonly boundary: "trace";
  readonly trace: UnclassifiedTraceCaptureContext;
}

export interface RecordClassificationInput<TClassification extends JsonValue> {
  readonly boundary: "record";
  readonly record: InstrumentationEvent;
  readonly trace: UnclassifiedTraceCaptureContext;
  readonly traceClassification: TClassification;
}

export type ClassificationPolicy<TClassification extends JsonValue> = (
  input: TraceClassificationInput | RecordClassificationInput<TClassification>,
  context: ClassificationPolicyContext,
) => TClassification | PromiseLike<TClassification>;

type ClassificationField<TClassification extends JsonValue | never> = [TClassification] extends [
  never,
]
  ? { readonly classification?: JsonValue }
  : { readonly classification: TClassification };

export type TraceCaptureContext<TClassification extends JsonValue | never = never> =
  UnclassifiedTraceCaptureContext & ClassificationField<TClassification>;

export type TraceCapturePolicy<TClassification extends JsonValue | never = never> = (
  trace: TraceCaptureContext<TClassification>,
) => TracePolicyDecision | boolean;
```

The policy may call any model or service or use deterministic local logic. Its
result must be a `JsonValue`.

## Lifecycle providers

The classification result is framework context, not private state owned by the
file that declares the classifier. Only one registered provider may declare
`classificationPolicy`; a second declaration is a startup error. Every
provider's trace policy receives the trace result, and every admitted lifecycle
handler receives the record result in `ProviderContext`.

```ts
export type ProviderContext<TClassification extends JsonValue | never = never> = {
  readonly state: ProviderState;
} & ClassificationField<TClassification>;

export type ProviderEvents<TClassification extends JsonValue | never = never> = {
  readonly [TType in InstrumentationEvent["type"]]?: Handler<
    EventForType<InstrumentationEvent, TType>,
    TClassification
  >;
};

export interface ProviderDefinition<TClassification extends JsonValue | never = never> {
  readonly classificationPolicy?: ClassificationPolicy<TClassification>;
  readonly tracePolicy?: TraceCapturePolicy<TClassification>;
  readonly events?: ProviderEvents<TClassification>;
  readonly setup?: (context: ProviderSetupContext) => void | PromiseLike<void>;
  readonly flush?: () => void | PromiseLike<void>;
  readonly shutdown?: () => void | PromiseLike<void>;
}

export function defineInstrumentation<const TClassification extends JsonValue | never = never>(
  definition: ProviderDefinition<TClassification>,
): InstrumentationProvider<TClassification>;
```

The classifier can be declared beside a lifecycle destination:

```ts
import { defineInstrumentation } from "eve/instrumentation";
import { classifySensitivity } from "../lib/sensitivity";

type Sensitivity = "ordinary" | "sensitive" | "restricted";

export default defineInstrumentation<Sensitivity>({
  classificationPolicy: (input, { abortSignal }) => classifySensitivity(input, { abortSignal }),

  tracePolicy: ({ classification }) => ({
    emit: true,
    recordInputs: classification === "ordinary",
    recordOutputs: classification === "ordinary",
  }),

  events: {
    "turn.failed": (event, { classification }) => {
      writeFailure(event, { classification });
    },
  },
});
```

Failed events participate like other records. Their error details are visible
to classification only when the trace content ceiling records outputs.

## OpenTelemetry projection

The internal OpenTelemetry adapter receives the same trace and record
classification as other lifecycle providers. It stores the active
classification in OTel context while it creates a span. The destination
processor exposes that value without requiring destination-specific
classification options:

```ts
export interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly audience: ChannelAudience;
  readonly classification?: JsonValue;
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
}
```

For a span mapped from one lifecycle record, `classification` is that record's
classification. Child model or tool spans inherit the active record
classification. Structural spans without a record-specific result use the
trace classification.

`agentRuns()` remains configured through its existing `exportPolicy`:

```ts
import { agentRuns } from "eve/instrumentation/otel";

export default agentRuns({
  exportPolicy: {
    span: ({ classification }) =>
      classification === "restricted"
        ? { redact: true, inputs: true, outputs: true }
        : { emit: true },
  },
});
```

`classificationPolicy` and destination-specific `tracePolicy` are not
`agentRuns()` options. Agent Runs, local traces, and authored OTel integrations
consume the classification projected by the instrumentation runtime.

## Ordering

1. Build the channel's audience, metadata, and classification-state
   projections.
2. Run trace classification.
3. Supply the trace result to each provider's `tracePolicy`.
4. Apply the resulting capture ceilings.
5. Project classifier input through the classifier owner's capture decision
   and every internal adapter ceiling, including OpenTelemetry.
6. Classify that privacy-filtered lifecycle record.
7. Supply the record result to lifecycle handlers and the internal OTel
   adapter.
8. Deliver each lifecycle provider its own independently projected event.
9. Expose the result to destination `exportPolicy` callbacks.

`tracePolicy` does not run for each message or record. Durable resume may bind
the trace again, so classification should return a stable result for the same
state.

## Failure behavior

- A trace-classification failure drops classified instrumentation for that
  trace.
- A record-classification failure drops that record from classified
  instrumentation.
- Invalid or non-JSON results fail closed.
- Classification is bounded by the instrumentation timeout and receives an
  abort signal.
- Classification cannot restore content removed by an earlier capture
  ceiling.

## Acceptance criteria

- One classification policy supplies trace and record results to all
  instrumentation providers.
- Lifecycle trace policies and handlers receive the typed result.
- OTel spans retain the active classification without exporting channel state
  as attributes.
- `SpanExportContext.classification` reaches Agent Runs, local traces, and
  authored OTel destinations.
- Existing destination configuration remains unchanged.
- Classification fails closed and cannot widen an earlier content decision.
