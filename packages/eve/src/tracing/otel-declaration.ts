import type {
  MetricReader,
  PropagatorOrName,
  SamplerOrName,
  SpanExporter,
  SpanProcessor,
  SpanProcessorOrName,
} from "#compiled/@vercel/otel/index.js";

import { PROVIDER, type InstrumentationProvider } from "#public/instrumentation/provider.js";
import type { InstrumentationRuntimeContextInput } from "#public/instrumentation/index.js";
import type { JsonObject } from "#shared/json.js";
import { batchSpanProcessor } from "#tracing/batch-span-processor.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";
export type {
  TraceCaptureContext,
  TraceCapturePolicy,
  TracePolicyDecision,
} from "#shared/trace-policy.js";
import type { SpanExportPolicy } from "#tracing/span-export-policy.js";

export type {
  SpanAttributeDecision,
  SpanExportAttributeValue,
  SpanExportContext,
  SpanExportDecision,
  SpanExportPolicy,
} from "#tracing/span-export-policy.js";

/**
 * The process-wide OpenTelemetry settings, declared by `otel()`.
 *
 * Everything here is a singleton, which is why it is one file: a process has
 * one tracer provider, so it has one resource, one sampler, and one propagator
 * set. Destinations are the plural half and live in `otelIntegration()`.
 *
 * `contextManager` is deliberately absent: eve's span nesting depends on it.
 * `instrumentations` is accepted so providers can opt into Node auto-
 * instrumentations (e.g. `@opentelemetry/auto-instrumentations-node`); the
 * packages patch modules eve already imported, so their effects are limited
 * to code loaded after registration.
 */
export interface OtelOptions {
  /**
   * The function identifier attached to telemetry spans
   * (`ai.telemetry.functionId`). Defaults to the agent name.
   */
  readonly functionId?: string;
  /**
   * Whether to emit an eve-owned HTTP `SERVER` span around each channel
   * request. For a one-to-one delivery, the activation remains a separate
   * trace root and links to this span; when disabled, it links to any
   * already-active upstream request or function span instead. Defaults to
   * `false`.
   */
  readonly traceChannelRequests?: boolean;
  /**
   * Process-wide trace and content decision. Boolean returns preserve the
   * existing audience-aware behavior; explicit decisions can disable emission
   * or select input and output capture independently. Defaults to emitting
   * every audience, with content only for public conversations. The result is
   * an OpenTelemetry capture ceiling: local delivery audience and destination
   * settings can only narrow it. For a trusted remote trace, eve evaluates this
   * policy against the immutable origin audience and intersects it with the
   * parent's effective ceiling, so every hop can only narrow capture. It never
   * changes what lifecycle instrumentation receives. A thrown error rejects trace production without
   * silencing lifecycle providers. The policy may be invoked more than once
   * while a new session is being prepared, so it must be deterministic for
   * consistent results.
   */
  readonly tracePolicy?: TraceCapturePolicy;
  /**
   * Resource attributes merged into eve's own, which already carry the
   * service name.
   */
  readonly resource?: Readonly<Record<string, unknown>>;
  /**
   * Head sampling, and it is global: it decides whether a span is created at
   * all, so it thins eve's own sinks and the `traceparent` eve propagates
   * along with your exporters. To thin one backend only, drop spans in a
   * processor.
   */
  readonly sampler?: SamplerOrName;
  /** Composed into one propagator. All inject; the first to extract wins. Defaults to `auto`. */
  readonly propagators?: readonly PropagatorOrName[];
  /**
   * OpenTelemetry `Instrumentation` instances passed through to
   * `registerOTel`. Use them to patch Node.js built-ins (HTTP, DNS, fs, etc.)
   * for automatic spans around outbound work. Disabled by default because eve
   * already imports the model SDK before registration, so patching cannot
   * reach it — but code loaded after registration (tool modules, connection
   * clients) will be instrumented.
   */
  readonly instrumentations?: readonly unknown[];
}

export interface ManagedTraceOptions {
  /** One destination policy, or policies applied in declaration order before export. */
  readonly exportPolicy?: SpanExportPolicy | readonly SpanExportPolicy[];
}

/** Where one `otelIntegration()` sends spans and metrics. */
export interface OtelIntegrationOptions extends ManagedTraceOptions {
  /** Merged into the pipeline in declaration order. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Wrapped in eve's batching processor and appended after `spanProcessors`. */
  readonly traceExporter?: SpanExporter;
  /**
   * Metric readers collected into the process's one meter provider in
   * declaration order. Without any, the meter provider is not created and
   * `metrics.getMeter()` returns a no-op meter. Readers come from the app's
   * own `@opentelemetry/sdk-metrics` install.
   */
  readonly metricReaders?: readonly MetricReader[];
  /**
   * Contributes runtime context that the AI SDK merges into telemetry spans
   * for each model call. Child spans inherit the values, so a destination can
   * stamp channel or auth identity onto every span in the turn.
   *
   * Synchronous: the harness collects from every destination before the model
   * call, so a return that is not a plain object is dropped (warning-only).
   * Keys beginning with `eve.` are reserved and dropped. Return `undefined`
   * to contribute nothing.
   */
  readonly runtimeContext?: (input: InstrumentationRuntimeContextInput) => JsonObject | undefined;
}

const OTEL_DECLARATION = Symbol.for("eve.instrumentation.otel");
const OTEL_INTEGRATION = Symbol.for("eve.instrumentation.otel-integration");

/**
 * The declared OpenTelemetry pipeline settings. eve collects this before
 * building the tracer provider, so it is a value rather than a side effect.
 */
export interface OtelDeclaration extends InstrumentationProvider {
  readonly [OTEL_DECLARATION]: true;
  readonly options: OtelOptions;
}

/** One declared destination. A process may have as many as it has files. */
export interface OtelIntegration extends InstrumentationProvider {
  readonly [OTEL_INTEGRATION]: true;
  readonly metricReaders: readonly MetricReader[];
  readonly runtimeContext?: (input: InstrumentationRuntimeContextInput) => JsonObject | undefined;
  readonly spanProcessors: readonly SpanProcessorOrName[];
}

/**
 * Declares the process-wide OpenTelemetry settings.
 *
 * Export it from `agent/instrumentation/otel.ts`. Omitting the file is the
 * common case: eve registers the pipeline for whatever destinations are
 * declared beside it, and this only names what those destinations share.
 */
export function otel(options: OtelOptions = {}): OtelDeclaration {
  return { [OTEL_DECLARATION]: true, [PROVIDER]: true, options };
}

/**
 * Declares one destination for this agent's traces.
 *
 * A `traceExporter` is wrapped in eve's batching processor, which is what makes
 * the one-line form of a hosted backend enough. Pass `spanProcessors` instead
 * when the destination needs its own batching, sampling, or filtering.
 *
 * The export policy wraps every processor here, an author's included: they are
 * this destination, and nothing beneath the policy sees what it removes.
 */
export function otelIntegration(options: OtelIntegrationOptions = {}): OtelIntegration {
  return createOtelIntegration(options);
}

/** @internal Managed local destination declaration. */
export function managedOtelIntegration(options: OtelIntegrationOptions = {}): OtelIntegration {
  return createOtelIntegration(options);
}

function createOtelIntegration(options: OtelIntegrationOptions): OtelIntegration {
  assertNoRemovedContentOptions(options);
  const declared = options.spanProcessors ?? [];
  const spanProcessors =
    options.traceExporter === undefined
      ? declared
      : [...declared, batchSpanProcessor(options.traceExporter)];

  return {
    [OTEL_INTEGRATION]: true,
    [PROVIDER]: true,
    metricReaders: options.metricReaders ?? [],
    runtimeContext: options.runtimeContext,
    spanProcessors: spanProcessors.map((processor) =>
      contentFilteringProcessor(processor, options.exportPolicy),
    ),
  };
}

function assertNoRemovedContentOptions(options: object): void {
  if (!Object.hasOwn(options, "recordInputs") && !Object.hasOwn(options, "recordOutputs")) return;
  throw new Error(
    "OpenTelemetry destination options no longer support `recordInputs` or `recordOutputs`. Use an `exportPolicy` span decision with `{ redact: true, inputs: true }`, `{ redact: true, outputs: true }`, or both.",
  );
}

export function isOtelDeclaration(value: unknown): value is OtelDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OtelDeclaration>)[OTEL_DECLARATION] === true
  );
}

export function isOtelIntegration(value: unknown): value is OtelIntegration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OtelIntegration>)[OTEL_INTEGRATION] === true
  );
}

/** The one pipeline a process can register. @internal */
export interface OtelPipeline {
  readonly instrumentations?: readonly unknown[];
  readonly metricReaders?: readonly MetricReader[];
  readonly propagators?: readonly PropagatorOrName[];
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly sampler?: SamplerOrName;
  readonly spanProcessors: readonly SpanProcessorOrName[];
}

/** What the harness reads at turn time, as opposed to at registration. @internal */
export interface OtelHarnessSettings {
  readonly functionId?: string;
  readonly traceChannelRequests: boolean;
  readonly tracePolicy?: TraceCapturePolicy;
  /** Whether AI SDK spans include model and tool inputs. */
  readonly recordInputs: boolean;
  /** Whether AI SDK spans include model and tool outputs. */
  readonly recordOutputs: boolean;
}

/** @internal */
export type RuntimeContextResolver = (
  input: InstrumentationRuntimeContextInput,
) => JsonObject | undefined;

/** @internal */
export interface CollectedOtel {
  /**
   * Whether anything declared OpenTelemetry. False means eve should leave the
   * global tracer provider slot alone rather than register an empty pipeline.
   */
  readonly declared: boolean;
  readonly pipeline: OtelPipeline;
  readonly runtimeContextResolvers: readonly RuntimeContextResolver[];
  readonly settings: OtelHarnessSettings;
}

/**
 * Folds the declared values into the one pipeline a process can register.
 *
 * Destinations concatenate in declaration order. The singletons cannot: two
 * `otel()` values is a boot error rather than a silent win for whichever eve
 * happened to visit first. With one declaration per file that collision needs
 * two files both exporting `otel()`, which is the only way to reach it.
 *
 * @internal
 */
export function collectOtelPipeline(values: readonly unknown[]): CollectedOtel {
  const spanProcessors: SpanProcessorOrName[] = [];
  const metricReaders: MetricReader[] = [];
  const runtimeContextResolvers: RuntimeContextResolver[] = [];
  let declaration: OtelDeclaration | undefined;
  let declared = false;
  let capturesContent = false;

  for (const value of values) {
    if (isOtelIntegration(value)) {
      declared = true;
      capturesContent = true;
      spanProcessors.push(...value.spanProcessors);
      metricReaders.push(...value.metricReaders);
      if (value.runtimeContext !== undefined) {
        runtimeContextResolvers.push(value.runtimeContext);
      }
      continue;
    }
    if (!isOtelDeclaration(value)) continue;
    if (declaration !== undefined) {
      throw new Error(
        "Instrumentation declares `otel()` more than once. One process has one OpenTelemetry tracer provider, so it has one resource, one sampler, and one propagator set — declare them in a single `otel()`.",
      );
    }
    declared = true;
    declaration = value;
  }

  const options = declaration?.options ?? {};
  const settings: OtelHarnessSettings = {
    functionId: options.functionId,
    recordInputs: capturesContent,
    recordOutputs: capturesContent,
    traceChannelRequests: options.traceChannelRequests === true,
  };
  if (options.tracePolicy !== undefined) {
    Object.assign(settings, { tracePolicy: options.tracePolicy });
  }
  return {
    declared,
    pipeline: {
      instrumentations: options.instrumentations,
      metricReaders: metricReaders.length > 0 ? metricReaders : undefined,
      propagators: options.propagators,
      resource: options.resource,
      sampler: options.sampler,
      spanProcessors,
    },
    runtimeContextResolvers,
    settings,
  };
}
