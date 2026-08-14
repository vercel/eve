import { createRequire } from "node:module";

import { context, propagation, trace, type Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ROOT_CONTEXT as COMPILED_ROOT_CONTEXT,
  context as runtimeContext,
  trace as runtimeTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { registerOtelPipeline } from "#tracing/otel-registration.js";

const require = createRequire(import.meta.url);
const authoredApi = require("@opentelemetry/api") as typeof import("@opentelemetry/api");

afterEach(() => {
  authoredApi.context.disable();
  authoredApi.propagation.disable();
  authoredApi.trace.disable();
  context.disable();
  propagation.disable();
  trace.disable();
  (runtimeContext as typeof runtimeContext & { disable(): void }).disable();
  (runtimeTrace as typeof runtimeTrace & { disable(): void }).disable();
});

describe("registerOtelPipeline", () => {
  it("delegates an authored tracer cached before registration", async () => {
    const authoredTracer = authoredApi.trace.getTracer("authored");
    expect(authoredTracer.startSpan("before-registration").isRecording()).toBe(false);

    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const runtime = registerOtelPipeline({
      pipeline: { spanProcessors: [processor] },
      serviceName: "weather",
    });
    const parent = runtimeTrace.getTracer("eve").startSpan("eve.parent");
    const parentContext = parent.spanContext();
    const activeContext = runtimeTrace.setSpan(COMPILED_ROOT_CONTEXT, parent);
    const child = await runtimeContext.with(activeContext, async () => {
      await Promise.resolve();
      return authoredTracer.startSpan("authored.child");
    });

    expect(child.isRecording()).toBe(true);
    expect(child.spanContext().traceId).toBe(parentContext.traceId);
    child.end();
    parent.end();
    await runtime.forceFlush();

    const exportedChild = exporter
      .getFinishedSpans()
      .find((span) => span.name === "authored.child");
    expect(exportedChild?.parentSpanContext?.spanId).toBe(parentContext.spanId);
    await runtime.shutdown();
  });

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
    expect(authoredApi.trace.setGlobalTracerProvider(provider)).toBe(true);
    const authoredProxy = authoredApi.trace.getTracerProvider();
    expect(authoredProxy).toBeInstanceOf(authoredApi.ProxyTracerProvider);
    const setDelegate = vi.spyOn(
      authoredProxy as InstanceType<typeof authoredApi.ProxyTracerProvider>,
      "setDelegate",
    );

    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [] },
        serviceName: "weather",
      }),
    ).toThrow(/another runtime already owns the global tracer provider/u);

    expect(currentTracerDelegate()).toBe(provider);
    expect(setDelegate).not.toHaveBeenCalled();
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
