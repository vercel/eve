import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context as globalContext } from "@opentelemetry/api";
import { ROOT_CONTEXT, context as otelContext } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  classificationCaptureProcessor,
  classificationProjectionProcessor,
} from "#tracing/classification-span-processor.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { withInstrumentationClassification } from "#tracing/instrumentation-classification-context.js";

function testSpan(): object {
  return {
    attributes: {
      "agent.channel.audience": "private",
      "gen_ai.output.messages": "private output",
      "service.name": "weather",
    },
    name: "chat",
    spanContext: () => ({ spanId: "span", traceId: "trace" }),
  };
}

describe("classificationSpanProcessor", () => {
  it("supplies terminal classification to span and attribute policies", () => {
    const started = vi.fn();
    const ended = vi.fn();
    const spanPolicy = vi.fn(() => ({ emit: true as const }));
    const attributePolicy = vi.fn(() => ({ emit: true as const }));
    const downstream: SpanProcessor = {
      forceFlush: async () => undefined,
      onEnd: ended,
      onStart: started,
      shutdown: async () => undefined,
    };
    const processor = classificationCaptureProcessor(
      classificationProjectionProcessor(
        contentFilteringProcessor(downstream, {
          attribute: attributePolicy,
          span: spanPolicy,
        }),
      ),
    );
    const span = testSpan();

    const manager = new AsyncLocalStorageContextManager().enable();
    globalContext.disable();
    globalContext.setGlobalContextManager(manager);
    try {
      processor.onStart(span as never, withInstrumentationClassification(ROOT_CONTEXT, "ordinary"));
      expect(started).not.toHaveBeenCalled();
      otelContext.with(withInstrumentationClassification(ROOT_CONTEXT, "restricted"), () =>
        processor.onEnd(span as never),
      );
    } finally {
      globalContext.disable();
      manager.disable();
    }

    expect(spanPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "restricted" }),
    );
    expect(attributePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        span: expect.objectContaining({ classification: "restricted" }),
      }),
    );
    expect(started).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(started.mock.calls[0]?.[0]).toBe(ended.mock.calls[0]?.[0]);
  });

  it("preserves immediate onStart behavior without classification", () => {
    const started = vi.fn();
    const ended = vi.fn();
    const processor = classificationCaptureProcessor(
      classificationProjectionProcessor({
        forceFlush: async () => undefined,
        onEnd: ended,
        onStart: started,
        shutdown: async () => undefined,
      }),
    );
    const span = testSpan();

    processor.onStart(span as never, ROOT_CONTEXT);
    expect(started).toHaveBeenCalledWith(span, ROOT_CONTEXT);
    processor.onEnd(span as never);
    expect(ended).toHaveBeenCalledWith(span);
  });
});
