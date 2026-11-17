import type { ChannelAudience } from "#shared/channel-audience.js";

/**
 * The span a {@link SpanExportPolicy} decides on: its name, IDs, attributes, and conversation
 * audience.
 */
export interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly audience: ChannelAudience;
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
}

/**
 * What to do with one span for a destination: `{ emit }` to keep or omit it, or `{ redact: true }`
 * with `inputs`, `outputs`, or both to keep it and remove that content.
 */
export type SpanExportDecision =
  | { readonly emit: boolean }
  | {
      readonly redact: true;
      readonly inputs?: boolean;
      readonly outputs?: boolean;
    };

/**
 * A value a {@link SpanAttributeDecision} may put on a span attribute: a primitive or a
 * homogeneous array of primitives.
 */
export type SpanExportAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/**
 * What to do with one span attribute for a destination: `{ emit }` to keep or remove it, or
 * `{ replace: true, value }` to change its value.
 */
export type SpanAttributeDecision =
  | { readonly emit: boolean }
  | { readonly replace: true; readonly value: SpanExportAttributeValue };

/**
 * Per-destination filtering applied before spans are exported: drop or redact whole spans, and
 * keep, remove, or replace individual attributes. A `span` callback that throws drops the span.
 */
export interface SpanExportPolicy {
  /** Drop one span or redact its directional content for this destination. */
  readonly span?: (span: SpanExportContext) => SpanExportDecision;
  /** Emit or replace individual span attributes after content filtering. */
  readonly attribute?: (input: {
    readonly key: string;
    readonly span: SpanExportContext;
    readonly value: unknown;
  }) => SpanAttributeDecision;
}

/** @internal */
export function normalizeSpanExportPolicies(
  policy: SpanExportPolicy | readonly SpanExportPolicy[] | undefined,
): readonly SpanExportPolicy[] {
  if (policy === undefined) return [];
  return Array.isArray(policy) ? policy : [policy as SpanExportPolicy];
}
