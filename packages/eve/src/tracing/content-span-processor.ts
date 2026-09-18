import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  withoutDeclinedContent,
  type ResolvedContentOptions,
} from "#tracing/content-attributes.js";
import { hasConversationRelease, type LocalTracesProcessor } from "#tracing/local-traces.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import {
  normalizeSpanExportPolicies,
  type SpanExportContext,
  type SpanExportDecision,
  type SpanExportPolicy,
} from "#tracing/span-export-policy.js";
import { channelAudienceFromContext } from "#tracing/channel-audience-context.js";

/**
 * Puts one destination's content policy in front of it.
 *
 * Accepted traces carry content before they reach destination policies. This
 * cannot strip an attribute in place: the span object is shared with every
 * processor in the pipeline, and editing it would strip the attribute
 * everywhere. So it gives the destination a facade whose attributes omit what
 * its policy redacted.
 *
 * One facade follows the original from start through end. This preserves the
 * object identity stateful processors key on without ever exposing the original
 * span or its attribute map. Methods stay bound to the original, so private SDK
 * state remains reachable without eve knowing that SDK's concrete span shape.
 *
 * @internal
 */
export function contentFilteringProcessor(
  downstream: SpanProcessor,
  exportPolicy?: SpanExportPolicy | readonly SpanExportPolicy[],
): SpanProcessor {
  const policies = normalizeSpanExportPolicies(exportPolicy);
  if (policies.length === 0) return downstream;

  let processor = downstream;
  for (const policy of policies.toReversed()) {
    processor = policyFilteringProcessor(processor, policy);
  }
  return processor;
}

function policyFilteringProcessor(
  downstream: SpanProcessor,
  exportPolicy: SpanExportPolicy,
): SpanProcessor {
  const facades = new WeakMap<object, SpanFacade>();
  const dropped = new WeakSet<object>();
  const filtering: SpanProcessor = {
    forceFlush: () => downstream.forceFlush(),
    onEnd: (span) => {
      if (typeof span !== "object" || span === null) {
        return;
      }

      const scoped = facadeFor(span, exportPolicy, facades);
      if (dropped.has(span) || !scoped.exported) {
        dropped.delete(span);
        facades.delete(span);
        return;
      }
      scoped.refresh();
      try {
        downstream.onEnd(scoped.value);
      } finally {
        facades.delete(span);
      }
    },
    onStart: (span, parentContext) => {
      if (typeof span !== "object" || span === null) {
        return;
      }
      const scoped = facadeFor(
        span,
        exportPolicy,
        facades,
        channelAudienceFromContext(parentContext),
      );
      if (!scoped.exported) {
        dropped.add(span);
        return;
      }
      downstream.onStart(scoped.value, parentContext);
    },
    shutdown: () => downstream.shutdown(),
  };

  if (!hasConversationRelease(downstream)) return filtering;
  const releasing: LocalTracesProcessor = {
    ...filtering,
    releaseConversation: (conversationId) => downstream.releaseConversation(conversationId),
  };
  return releasing;
}

interface SpanFacade {
  readonly context: SpanExportContext;
  readonly exported: boolean;
  readonly refresh: () => void;
  readonly value: object;
}

function facadeFor(
  span: object,
  exportPolicy: SpanExportPolicy,
  facades: WeakMap<object, SpanFacade>,
  inheritedAudience?: ChannelAudience,
): SpanFacade {
  const existing = facades.get(span);
  if (existing !== undefined) return existing;

  const context = spanExportContext(span, inheritedAudience);
  const decision = spanExportDecision(context, exportPolicy);
  const effectiveContent = {
    recordInputs: !decision.redactInputs,
    recordOutputs: !decision.redactOutputs,
  };
  const attributes: Record<string, unknown> = {};
  const events: unknown[] = [];
  const status: Record<string, unknown> = {};
  const target = Object.create(Reflect.getPrototypeOf(span)) as Record<PropertyKey, unknown>;
  const boundMethods = new Map<PropertyKey, unknown>();
  const refresh = (): void => {
    refreshAttributes(attributes, span, effectiveContent, context, exportPolicy);
    refreshEvents(events, span, effectiveContent);
    refreshStatus(status, span, effectiveContent);
  };
  let value: object;
  const readOriginal = (property: PropertyKey): unknown => {
    const original = Reflect.get(span, property, span) as unknown;
    if (typeof original !== "function" || property === "constructor") return original;

    const bound = boundMethods.get(property);
    if (bound !== undefined) return bound;
    const created = (...args: unknown[]) => {
      const result = Reflect.apply(original, span, args) as unknown;
      refresh();
      return result === span ? value : result;
    };
    boundMethods.set(property, created);
    return created;
  };

  Object.defineProperty(target, "attributes", {
    configurable: true,
    enumerable: true,
    value: attributes,
  });
  Object.defineProperty(target, "events", {
    configurable: true,
    enumerable: true,
    value: events,
  });
  Object.defineProperty(target, "status", {
    configurable: true,
    enumerable: true,
    value: status,
  });
  for (const property of Reflect.ownKeys(span)) {
    if (property === "attributes" || property === "events" || property === "status") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(span, property);
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      get: () => readOriginal(property),
    });
  }

  value = new Proxy(target, {
    get: (facadeTarget, property, receiver) =>
      Object.hasOwn(facadeTarget, property)
        ? Reflect.get(facadeTarget, property, receiver)
        : readOriginal(property),
  });
  const facade = {
    context,
    exported: decision.exported,
    refresh,
    value,
  };
  facade.refresh();
  facades.set(span, facade);
  return facade;
}

function refreshAttributes(
  destination: Record<string, unknown>,
  span: object,
  content: ResolvedContentOptions,
  context: SpanExportContext,
  policy: SpanExportPolicy | undefined,
): void {
  for (const key of Object.keys(destination)) delete destination[key];

  const source = (span as { readonly attributes?: unknown }).attributes;
  if (typeof source !== "object" || source === null) return;

  const kept = withoutDeclinedContent(source as Record<string, unknown>, content);
  const visible = kept ?? (source as Record<string, unknown>);
  for (const [key, value] of Object.entries(visible)) {
    const decision = attributeDecision(policy, { key, span: context, value });
    if (typeof decision !== "object" || decision === null) continue;
    if ("emit" in decision && "replace" in decision) continue;
    if ("replace" in decision && decision.replace === true) {
      if (decision.value !== undefined) destination[key] = decision.value;
    } else if ("emit" in decision && decision.emit === true) {
      destination[key] = value;
    }
  }
}

function spanExportContext(
  span: object,
  inheritedAudience: ChannelAudience = "unknown",
): SpanExportContext {
  const attributes = (span as { readonly attributes?: unknown }).attributes;
  const record =
    typeof attributes === "object" && attributes !== null
      ? (attributes as Readonly<Record<string, unknown>>)
      : {};
  const candidates = [
    record["agent.channel.audience"],
    record["ai.settings.context.eve.channel.audience"],
  ].filter((value) => value !== undefined);
  const normalized = candidates.map(normalizeChannelAudience);
  const audience =
    normalized.length > 0 && normalized.every((value) => value === normalized[0])
      ? normalized[0]!
      : normalized.length > 0
        ? "unknown"
        : inheritedAudience;
  const spanContext = (span as { readonly spanContext?: () => unknown }).spanContext?.();
  const ids =
    typeof spanContext === "object" && spanContext !== null
      ? (spanContext as Readonly<Record<string, unknown>>)
      : {};
  const name = (span as { readonly name?: unknown }).name;
  return {
    attributes: record,
    audience,
    name: typeof name === "string" ? name : "",
    spanId: typeof ids["spanId"] === "string" ? ids["spanId"] : "",
    traceId: typeof ids["traceId"] === "string" ? ids["traceId"] : "",
  };
}

function spanExportDecision(
  context: SpanExportContext,
  policy: SpanExportPolicy,
): {
  readonly exported: boolean;
  readonly redactInputs: boolean;
  readonly redactOutputs: boolean;
} {
  let decision: SpanExportDecision;
  try {
    decision = policy.span?.(context) ?? { emit: true };
  } catch {
    return { exported: false, redactInputs: false, redactOutputs: false };
  }
  if (typeof decision === "boolean") {
    return { exported: decision, redactInputs: false, redactOutputs: false };
  }
  if (typeof decision !== "object" || decision === null) {
    return { exported: false, redactInputs: false, redactOutputs: false };
  }
  if ("emit" in decision) {
    if ("redact" in decision) {
      return { exported: false, redactInputs: false, redactOutputs: false };
    }
    return {
      exported: typeof decision.emit === "boolean" && decision.emit,
      redactInputs: false,
      redactOutputs: false,
    };
  }
  if (decision.redact !== true) {
    return { exported: false, redactInputs: false, redactOutputs: false };
  }
  const redactInputs = decision.inputs === true;
  const redactOutputs = decision.outputs === true;
  if (!redactInputs && !redactOutputs) {
    return { exported: false, redactInputs: false, redactOutputs: false };
  }
  return {
    exported: true,
    redactInputs,
    redactOutputs,
  };
}

function attributeDecision(
  policy: SpanExportPolicy | undefined,
  input: Parameters<NonNullable<SpanExportPolicy["attribute"]>>[0],
) {
  if (policy?.attribute === undefined) return { emit: true } as const;
  try {
    return policy.attribute(input);
  } catch {
    return { emit: false } as const;
  }
}

function refreshEvents(
  destination: unknown[],
  span: object,
  content: ResolvedContentOptions,
): void {
  destination.length = 0;
  const source = (span as { readonly events?: unknown }).events;
  if (!Array.isArray(source)) return;
  if (content.recordOutputs) {
    destination.push(...source);
    return;
  }
  for (const event of source) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Readonly<Record<string, unknown>>;
    if (record["name"] === "exception") continue;
    destination.push({ ...record, attributes: undefined });
  }
}

function refreshStatus(
  destination: Record<string, unknown>,
  span: object,
  content: ResolvedContentOptions,
): void {
  for (const key of Object.keys(destination)) delete destination[key];
  const source = (span as { readonly status?: unknown }).status;
  if (typeof source !== "object" || source === null) return;
  const record = source as Readonly<Record<string, unknown>>;
  if (record["code"] !== undefined) destination["code"] = record["code"];
  if (content.recordOutputs && record["message"] !== undefined) {
    destination["message"] = record["message"];
  }
}
