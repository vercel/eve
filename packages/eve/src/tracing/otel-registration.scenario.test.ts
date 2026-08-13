import { context, propagation, trace, type Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOtelPipeline } from "#tracing/otel-registration.js";

afterEach(() => {
  context.disable();
  propagation.disable();
  trace.disable();
});

describe("registerOtelPipeline", () => {
  it("verifies tracer ownership when the sampler records nothing", () => {
    expect(() =>
      registerOtelPipeline({
        pipeline: { sampler: "always_off", spanProcessors: [] },
        serviceName: "weather",
      }),
    ).not.toThrow();
  });

  it("fails without replacing another runtime's global propagator", async () => {
    let foreignInjections = 0;
    const shutdown = vi.fn(async () => undefined);
    expect(
      propagation.setGlobalPropagator({
        extract: (carrierContext: Context) => carrierContext,
        fields: () => [],
        inject: () => {
          foreignInjections += 1;
        },
      }),
    ).toBe(true);
    const tracerDelegate = currentTracerDelegate();

    expect(() =>
      registerOtelPipeline({
        pipeline: {
          spanProcessors: [
            { forceFlush: async () => {}, onEnd: () => {}, onStart: () => {}, shutdown },
          ],
        },
        serviceName: "weather",
      }),
    ).toThrow(/another runtime already owns the global propagator/u);

    const injectionsAfterFailure = foreignInjections;
    propagation.inject(context.active(), {}, { set: () => {} });
    expect(foreignInjections).toBe(injectionsAfterFailure + 1);
    expect(currentTracerDelegate()).toBe(tracerDelegate);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it("leaves an existing tracer provider untouched when registration fails", () => {
    const provider = new BasicTracerProvider();
    const shutdown = vi.spyOn(provider, "shutdown");
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);

    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [] },
        serviceName: "weather",
      }),
    ).toThrow(/another runtime already owns the global tracer provider/u);

    expect(currentTracerDelegate()).toBe(provider);
    expect(shutdown).not.toHaveBeenCalled();
    expect(
      propagation.setGlobalPropagator({
        extract: (carrierContext: Context) => carrierContext,
        fields: () => [],
        inject: () => {},
      }),
    ).toBe(true);
  });

  it("does not export the private registration span", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const shutdown = vi.spyOn(processor, "shutdown");
    const runtime = registerOtelPipeline({
      pipeline: { spanProcessors: [processor] },
      serviceName: "weather",
    });

    trace.getTracer("test").startSpan("user.work").end();
    await processor.forceFlush();

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["user.work"]);
    await runtime.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

function currentTracerDelegate(): unknown {
  const provider = trace.getTracerProvider() as { getDelegate?: () => unknown };
  return provider.getDelegate?.();
}
