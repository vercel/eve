import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  withoutDeclinedContent,
  type ResolvedContentOptions,
} from "#tracing/content-attributes.js";
import { hasSessionRelease, type LocalTracesProcessor } from "#tracing/local-traces.js";

/**
 * Puts one destination's content policy in front of it.
 *
 * Content is written onto a span if any destination wants it, so the span
 * reaching a destination that declined still carries it. This cannot strip the
 * attribute in place: that span object is shared with every other processor in
 * the pipeline, and editing it would strip the attribute everywhere. So it
 * gives the destination a facade whose attributes omit what it declined.
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
  content: ResolvedContentOptions,
): SpanProcessor {
  if (content.recordInputs && content.recordOutputs) return downstream;

  const facades = new WeakMap<object, SpanFacade>();
  const filtering: SpanProcessor = {
    forceFlush: () => downstream.forceFlush(),
    onEnd: (span) => {
      if (typeof span !== "object" || span === null) {
        downstream.onEnd(span);
        return;
      }

      const scoped = facadeFor(span, content, facades);
      scoped.refresh();
      try {
        downstream.onEnd(scoped.value);
      } finally {
        facades.delete(span);
      }
    },
    onStart: (span, parentContext) => {
      if (typeof span !== "object" || span === null) {
        downstream.onStart(span, parentContext);
        return;
      }
      downstream.onStart(facadeFor(span, content, facades).value, parentContext);
    },
    shutdown: () => downstream.shutdown(),
  };

  if (!hasSessionRelease(downstream)) return filtering;
  const releasing: LocalTracesProcessor = {
    ...filtering,
    releaseSession: (sessionId) => downstream.releaseSession(sessionId),
  };
  return releasing;
}

interface SpanFacade {
  readonly refresh: () => void;
  readonly value: object;
}

function facadeFor(
  span: object,
  content: ResolvedContentOptions,
  facades: WeakMap<object, SpanFacade>,
): SpanFacade {
  const existing = facades.get(span);
  if (existing !== undefined) return existing;

  const attributes: Record<string, unknown> = {};
  const events: unknown[] = [];
  const status: Record<string, unknown> = {};
  const target = Object.create(Reflect.getPrototypeOf(span)) as Record<PropertyKey, unknown>;
  const boundMethods = new Map<PropertyKey, unknown>();
  const refresh = (): void => {
    refreshAttributes(attributes, span, content);
    refreshEvents(events, span, content);
    refreshStatus(status, span, content);
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
): void {
  for (const key of Object.keys(destination)) delete destination[key];

  const source = (span as { readonly attributes?: unknown }).attributes;
  if (typeof source !== "object" || source === null) return;

  const kept = withoutDeclinedContent(source as Record<string, unknown>, content);
  Object.assign(destination, kept ?? source);
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
