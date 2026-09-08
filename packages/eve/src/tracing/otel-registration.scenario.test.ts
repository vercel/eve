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
  metrics as runtimeMetrics,
  trace as runtimeTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { registerOtelPipeline } from "#tracing/otel-registration.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { createLogger, logError } from "#internal/logging.js";

const require = createRequire(import.meta.url);
const authoredApi = require("@opentelemetry/api") as typeof import("@opentelemetry/api");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  authoredApi.context.disable();
  authoredApi.metrics.disable();
  authoredApi.propagation.disable();
  authoredApi.trace.disable();
  context.disable();
  propagation.disable();
  trace.disable();
  (runtimeContext as typeof runtimeContext & { disable(): void }).disable();
  (runtimeMetrics as typeof runtimeMetrics & { disable(): void }).disable();
  (runtimeTrace as typeof runtimeTrace & { disable(): void }).disable();
});

describe("registerOtelPipeline", () => {
  it("samples using the real activation name and attributes without exporting probes", async () => {
    const exporter = new InMemorySpanExporter();
    const sampler = {
      shouldSample: (
        _context: unknown,
        _traceId: string,
        name: string,
        _kind: unknown,
        attributes: Record<string, unknown>,
      ) => ({
        decision:
          name === "invoke_agent researcher" && attributes["agent.session.id"] === "session-1"
            ? 2
            : 0,
      }),
      toString: () => "activation-sampler",
    };
    const runtime = registerOtelPipeline({
      pipeline: { sampler, spanProcessors: [new SimpleSpanProcessor(exporter)] },
      serviceName: "researcher",
    });
    const operation = {
      name: "invoke_agent researcher",
      attributes: { "agent.session.id": "session-1" },
    };
    expect(runtime.samplesTrace("a".repeat(32), operation)).toBe(true);
    expect(
      runtime.samplesTrace("b".repeat(32), {
        ...operation,
        attributes: { "agent.session.id": "other" },
      }),
    ).toBe(false);
    runtimeTrace
      .getTracer("eve.agent")
      .startSpan(operation.name, { attributes: operation.attributes, root: true })
      .end();
    await runtime.forceFlush();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([operation.name]);
    await runtime.shutdown();
  });

  it.each(["traceidratio", "parentbased_traceidratio"] as const)(
    "honors the configured %s root ratio",
    async (sampler) => {
      vi.stubEnv("OTEL_TRACES_SAMPLER_ARG", "0");
      const runtime = registerOtelPipeline({
        pipeline: { sampler, spanProcessors: [] },
        serviceName: "test",
      });
      expect(runtime.samplesTrace("a".repeat(32), { name: "invoke_agent test" })).toBe(false);
      await runtime.shutdown();
    },
  );

  it("keeps logger-to-span error details behind the active output policy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    const runtime = registerOtelPipeline({
      pipeline: { spanProcessors: [new SimpleSpanProcessor(exporter)] },
      serviceName: "test",
    });
    for (const allowed of [false, true]) {
      const span = runtimeTrace.getTracer("eve.agent").startSpan(`logger-${allowed}`);
      const active = withErrorContent(runtimeTrace.setSpan(COMPILED_ROOT_CONTEXT, span), allowed);
      await runtimeContext.with(active, async () => {
        logError(createLogger("test"), "operation failed", new Error("sensitive payload"));
      });
      span.end();
    }
    await runtime.forceFlush();
    const [privateSpan, publicSpan] = exporter.getFinishedSpans();
    expect(privateSpan?.status.code).toBe(2);
    expect(privateSpan?.status.message).toBeUndefined();
    expect(privateSpan?.events).toEqual([]);
    expect(publicSpan?.status.message).toContain("sensitive payload");
    expect(publicSpan?.events[0]?.attributes?.["exception.message"]).toContain("sensitive payload");
    await runtime.shutdown();
  });

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

  it("reports the installed sampler's verdict for pre-allocated trace ids", () => {
    const runtime = registerOtelPipeline({
      pipeline: { sampler: "always_off", spanProcessors: [] },
      serviceName: "weather",
    });

    expect(runtime.samplesTrace(runtime.idGenerator.generateTraceId())).toBe(false);
  });

  it("passes the pre-allocated trace id to a custom sampler without exporting the probe", async () => {
    const seen: string[] = [];
    const sampler: NonNullable<Parameters<typeof registerOtelPipeline>[0]["pipeline"]["sampler"]> =
      {
        shouldSample: (_context: unknown, traceId: string) => {
          seen.push(traceId);
          return { decision: traceId.startsWith("a") ? 2 : 0 };
        },
        toString: () => "test-sampler",
      };
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const runtime = registerOtelPipeline({
      pipeline: {
        sampler,
        spanProcessors: [processor],
      },
      serviceName: "weather",
    });

    expect(runtime.samplesTrace("a".repeat(32))).toBe(true);
    expect(runtime.samplesTrace("b".repeat(32))).toBe(false);
    expect(seen).toContain("a".repeat(32));
    expect(seen).toContain("b".repeat(32));

    await runtime.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);
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

  it("flushes and shuts down the registered meter provider", async () => {
    const reader = {
      forceFlush: vi.fn(async () => {}),
      setMetricProducer: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const runtime = registerOtelPipeline({
      pipeline: { metricReaders: [reader], spanProcessors: [] },
      serviceName: "weather",
    });

    await runtime.forceFlush();
    expect(reader.forceFlush).toHaveBeenCalledOnce();
    expect(reader.shutdown).not.toHaveBeenCalled();

    await runtime.shutdown();
    expect(reader.shutdown).toHaveBeenCalledOnce();
  });

  it("disables declared instrumentations at shutdown", async () => {
    const instrumentation = {
      disable: vi.fn(),
      enable: vi.fn(),
      getConfig: () => ({ enabled: false }),
      setMeterProvider: vi.fn(),
      setTracerProvider: vi.fn(),
    };
    const runtime = registerOtelPipeline({
      pipeline: { instrumentations: [instrumentation], spanProcessors: [] },
      serviceName: "weather",
    });
    expect(instrumentation.enable).toHaveBeenCalledOnce();
    expect(instrumentation.disable).not.toHaveBeenCalled();

    await runtime.shutdown();
    expect(instrumentation.disable).toHaveBeenCalledOnce();
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
