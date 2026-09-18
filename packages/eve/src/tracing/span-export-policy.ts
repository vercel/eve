import type { ChannelAudience } from "#shared/channel-audience.js";

export interface SpanExportContext {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly audience: ChannelAudience;
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
}

export type SpanExportDecision =
  /** @deprecated Return `{ emit: boolean }` instead. */
  | boolean
  | { readonly emit: boolean }
  | {
      readonly redact: true;
      readonly inputs?: boolean;
      readonly outputs?: boolean;
    };

export type SpanExportAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type SpanAttributeDecision =
  | { readonly emit: boolean }
  | { readonly replace: true; readonly value: SpanExportAttributeValue };

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
