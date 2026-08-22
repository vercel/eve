import type {
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
import type { ResolvedContentOptions } from "#tracing/content-attributes.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { vercelRuntimeSpanProcessor } from "#tracing/vercel-runtime-span-exporter.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import {
  composeSpanExportPolicies,
  redactSpanInputs,
  redactSpanOutputs,
  type SpanExportPolicy,
} from "#tracing/span-export-policy.js";

export type {
  SpanAttributeDecision,
  SpanExportAttributeValue,
  SpanExportContext,
  SpanExportPolicy,
  SpanExportPredicate,
} from "#tracing/span-export-policy.js";
export {
  composeSpanExportPolicies,
  redactSpanInputs,
  redactSpanOutputs,
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
   * Whether to emit the inbound HTTP `SERVER` span that wraps each channel
   * request — the parent of the turn trace and of any `hook.resume` or
   * outgoing HTTP spans. Defaults to `false`.
   */
  readonly traceChannelRequests?: boolean;
  /**
   * Process-wide head gate for an agent session trace. Defaults to retaining
   * only public conversations. A thrown error rejects the trace.
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
  /** Destination policy applied before spans are exported. */
  readonly exportPolicy?: SpanExportPolicy;
  /** @deprecated Use `exportPolicy: redactSpanInputs()` instead. */
  readonly recordInputs?: boolean;
  /** @deprecated Use `exportPolicy: redactSpanOutputs()` instead. */
  readonly recordOutputs?: boolean;
}

/** @deprecated Compose `redactSpanInputs()` and `redactSpanOutputs()` into an export policy. */
export interface ContentOptions {
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
}

export interface TraceCaptureContext {
  readonly agentName?: string;
  readonly audience: ChannelAudience;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export type TraceCapturePolicy = (trace: TraceCaptureContext) => boolean;

/** Where one `otelIntegration()` sends spans. */
export interface OtelIntegrationOptions extends ContentOptions {
  /** Merged into the pipeline in declaration order. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Wrapped in eve's batching processor and appended after `spanProcessors`. */
  readonly traceExporter?: SpanExporter;
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
  /** @deprecated Content is captured upstream and redacted by destination policies. */
  readonly content: ResolvedContentOptions;
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

/** @internal Local and Agent Runs destination declaration. */
export function managedOtelIntegration(
  options: OtelIntegrationOptions & ManagedTraceOptions = {},
): OtelIntegration {
  return createOtelIntegration(options, options.exportPolicy);
}

function createOtelIntegration(
  options: OtelIntegrationOptions,
  exportPolicy?: SpanExportPolicy,
): OtelIntegration {
  const declared = options.spanProcessors ?? [];
  const spanProcessors =
    options.traceExporter === undefined
      ? declared
      : [...declared, batchSpanProcessor(options.traceExporter)];

  return {
    [OTEL_INTEGRATION]: true,
    [PROVIDER]: true,
    content: resolveContentOptions(options),
    runtimeContext: options.runtimeContext,
    spanProcessors: spanProcessors.map((processor) =>
      withExportPolicies(processor, legacyContentRedactionPolicy(options), exportPolicy),
    ),
  };
}

/** Vercel Agent Runs through the production request-context transport. @internal */
export function agentRunsIntegration(options: ManagedTraceOptions = {}): OtelIntegration {
  return {
    [OTEL_INTEGRATION]: true,
    [PROVIDER]: true,
    content: resolveContentOptions(options),
    spanProcessors: [
      withExportPolicies(
        vercelRuntimeSpanProcessor(),
        legacyContentRedactionPolicy(options),
        options.exportPolicy,
      ),
    ],
  };
}

function legacyContentRedactionPolicy(options: ContentOptions): SpanExportPolicy | undefined {
  const policies: SpanExportPolicy[] = [];
  if (options.recordInputs === false) policies.push(redactSpanInputs());
  if (options.recordOutputs === false) policies.push(redactSpanOutputs());
  return policies.length === 0 ? undefined : composeSpanExportPolicies(...policies);
}

export function resolveContentOptions(options: ContentOptions): ResolvedContentOptions {
  return {
    recordInputs: options.recordInputs !== false,
    recordOutputs: options.recordOutputs !== false,
  };
}

function withExportPolicies(
  downstream: SpanProcessor,
  ...policies: readonly (SpanExportPolicy | undefined)[]
): SpanProcessor {
  let processor = downstream;
  for (const policy of policies.toReversed()) {
    processor = contentFilteringProcessor(processor, policy);
  }
  return processor;
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
  /** Legacy `defineInstrumentation()` capture settings. Provider destinations capture fully. */
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
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
  const runtimeContextResolvers: RuntimeContextResolver[] = [];
  let declaration: OtelDeclaration | undefined;
  let declared = false;
  let capturesContent = false;

  for (const value of values) {
    if (isOtelIntegration(value)) {
      declared = true;
      capturesContent = true;
      spanProcessors.push(...value.spanProcessors);
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
      propagators: options.propagators,
      resource: options.resource,
      sampler: options.sampler,
      spanProcessors,
    },
    runtimeContextResolvers,
    settings,
  };
}
