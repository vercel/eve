import type { ChannelAudience } from "#shared/channel-audience.js";

export interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly audience: ChannelAudience;
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
}

export type SpanExportPredicate = (span: SpanExportContext) => boolean;

export type SpanExportAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type SpanAttributeDecision =
  | { readonly action: "keep" }
  | { readonly action: "drop" }
  | { readonly action: "replace"; readonly value: SpanExportAttributeValue };

export interface SpanExportPolicy {
  /** Return false to block one span without blocking its trace. */
  readonly span?: SpanExportPredicate;
  /** Drop or replace individual span attributes after content filtering. */
  readonly attribute?: (input: {
    readonly key: string;
    readonly span: SpanExportContext;
    readonly value: unknown;
  }) => SpanAttributeDecision;
}

interface ContentRedaction {
  readonly inputs: readonly SpanExportPredicate[];
  readonly outputs: readonly SpanExportPredicate[];
}

const contentRedactions = new WeakMap<SpanExportPolicy, ContentRedaction>();
const composedPolicies = new WeakMap<SpanExportPolicy, readonly SpanExportPolicy[]>();

/** Redact input content from every matching span. */
export function redactSpanInputs(when: SpanExportPredicate = () => true): SpanExportPolicy {
  const policy = {};
  contentRedactions.set(policy, { inputs: [when], outputs: [] });
  return policy;
}

/** Redact output content, exception details, and status messages from every matching span. */
export function redactSpanOutputs(when: SpanExportPredicate = () => true): SpanExportPolicy {
  const policy = {};
  contentRedactions.set(policy, { inputs: [], outputs: [when] });
  return policy;
}

/** Compose policies in declaration order. A drop or redaction from any policy is final. */
export function composeSpanExportPolicies(
  ...policies: readonly SpanExportPolicy[]
): SpanExportPolicy {
  if (policies.length === 0) return {};
  if (policies.length === 1) return policies[0]!;
  const composed = {};
  composedPolicies.set(composed, policies.flatMap(spanExportPolicyStages));
  return composed;
}

/** @internal */
export function spanExportPolicyStages(policy: SpanExportPolicy): readonly SpanExportPolicy[] {
  return composedPolicies.get(policy) ?? [policy];
}

/** @internal */
export function contentRedactionForSpan(
  policy: SpanExportPolicy | undefined,
  span: SpanExportContext,
): { readonly redactInputs: boolean; readonly redactOutputs: boolean } {
  const redaction = policy === undefined ? undefined : contentRedactions.get(policy);
  return {
    redactInputs: redaction?.inputs.some((when) => matches(when, span)) ?? false,
    redactOutputs: redaction?.outputs.some((when) => matches(when, span)) ?? false,
  };
}

function matches(predicate: SpanExportPredicate, span: SpanExportContext): boolean {
  try {
    return predicate(span);
  } catch {
    // Redaction predicates fail closed.
    return true;
  }
}
