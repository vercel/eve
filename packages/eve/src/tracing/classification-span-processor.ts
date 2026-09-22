import { context as otelContext } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import type { JsonValue } from "#shared/json.js";
import { instrumentationClassificationFromContext } from "#tracing/instrumentation-classification-context.js";

const classifications = new WeakMap<object, JsonValue>();

/**
 * Captures classification at the SDK boundary before parent/child buffering
 * can defer destination delivery.
 */
export function classificationCaptureProcessor(downstream: SpanProcessor): SpanProcessor {
  return {
    forceFlush: () => downstream.forceFlush(),
    onEnd(span) {
      if (typeof span === "object" && span !== null) {
        const terminal = instrumentationClassificationFromContext(otelContext.active());
        if (terminal !== undefined) classifications.set(span, terminal);
      }
      downstream.onEnd(span);
    },
    onStart(span, parentContext) {
      if (typeof span === "object" && span !== null) {
        const classification =
          instrumentationClassificationFromContext(otelContext.active()) ??
          instrumentationClassificationFromContext(parentContext);
        if (classification !== undefined) classifications.set(span, classification);
      }
      downstream.onStart(span, parentContext);
    },
    shutdown: () => downstream.shutdown(),
  };
}

/**
 * Delays one destination's `onStart` until span end so export policies see the
 * terminal classification while preserving upstream parent/child ordering.
 */
export function classificationProjectionProcessor(downstream: SpanProcessor): SpanProcessor {
  const spans = new WeakMap<object, ClassifiedSpan>();
  return {
    forceFlush: () => downstream.forceFlush(),
    onEnd(span) {
      if (typeof span !== "object" || span === null) return;
      const classified = spans.get(span);
      spans.delete(span);
      if (classified === undefined || !classified.delayed) {
        downstream.onEnd(span);
        return;
      }
      classified.classification.value =
        classifications.get(span) ?? classified.classification.value;
      downstream.onStart(classified.value as never, classified.parentContext as never);
      downstream.onEnd(classified.value as never);
    },
    onStart(span, parentContext) {
      if (typeof span !== "object" || span === null) return;
      const classification = classifications.get(span);
      if (classification === undefined) {
        spans.set(span, createClassifiedSpan(span, parentContext, undefined, false));
        downstream.onStart(span, parentContext);
        return;
      }
      spans.set(span, createClassifiedSpan(span, parentContext, classification, true));
    },
    shutdown: () => downstream.shutdown(),
  };
}

interface ClassifiedSpan {
  readonly classification: { value?: JsonValue };
  readonly delayed: boolean;
  readonly parentContext: unknown;
  readonly value: object;
}

function createClassifiedSpan(
  span: object,
  parentContext: unknown,
  classification: JsonValue | undefined,
  delayed: boolean,
): ClassifiedSpan {
  const state: { value?: JsonValue } = { value: classification };
  const boundMethods = new Map<PropertyKey, unknown>();
  const value = new Proxy(span, {
    get(target, property) {
      if (property === "classification") return state.value;
      const original = Reflect.get(target, property, target) as unknown;
      if (typeof original !== "function" || property === "constructor") return original;
      const bound = boundMethods.get(property);
      if (bound !== undefined) return bound;
      const created = (...args: unknown[]) => Reflect.apply(original, target, args) as unknown;
      boundMethods.set(property, created);
      return created;
    },
  });
  return { classification: state, delayed, parentContext, value };
}
