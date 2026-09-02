import { describe, expect, it, vi } from "vitest";

import { registerOtelPipeline } from "#tracing/otel-registration.js";

const { registerOTel } = vi.hoisted(() => ({ registerOTel: vi.fn() }));

vi.mock("#compiled/@vercel/otel/index.js", () => ({ registerOTel }));

describe("registerOtelPipeline", () => {
  it("maps eve's option names onto the ones @vercel/otel accepts", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({
        pipeline: {
          propagators: ["tracecontext"],
          resource: { "service.version": "abc" },
          sampler: "always_on",
          spanProcessors: [],
        },
        serviceName: "weather",
      }),
    ).toThrow();

    expect(registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: { "service.version": "abc" },
        autoDetectResources: false,
        instrumentations: [],
        propagators: expect.arrayContaining(["tracecontext", expect.any(Object)]),
        serviceName: "weather",
        traceSampler: "always_on",
      }),
    );
  });

  it("omits the sampler entirely rather than passing undefined", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({ pipeline: { spanProcessors: [] }, serviceName: "weather" }),
    ).toThrow(/already owns the global tracer provider/u);

    const configuration = registerOTel.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect("traceSampler" in configuration).toBe(false);
    // Absent propagators keep @vercel/otel's automatic defaults; eve's marker follows them.
    expect(configuration["propagators"]).toEqual(["auto", expect.any(Object)]);
  });

  it("filters the private registration span from authored processors", () => {
    const downstream = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [downstream] },
        serviceName: "weather",
      }),
    ).toThrow();

    const configuration = registerOTel.mock.calls.at(-1)?.[0] as {
      spanProcessors: {
        onEnd(span: unknown): void;
        onStart(span: unknown, parentContext: unknown): void;
      }[];
    };
    const processor = configuration.spanProcessors[0]!;
    processor.onStart({ name: "eve.otel.registration" }, {});
    processor.onEnd({ name: "eve.otel.registration" });
    processor.onStart({ name: "agent.turn" }, {});
    processor.onEnd({ name: "agent.turn" });

    expect(downstream.onStart).toHaveBeenCalledExactlyOnceWith({ name: "agent.turn" }, {});
    expect(downstream.onEnd).toHaveBeenCalledExactlyOnceWith({ name: "agent.turn" });
  });

  it("passes Vercel's automatic processor through", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({ pipeline: { spanProcessors: ["auto"] }, serviceName: "weather" }),
    ).toThrow();

    const configuration = registerOTel.mock.calls.at(-1)?.[0] as {
      spanProcessors: unknown[];
    };
    expect(configuration.spanProcessors[0]).toBe("auto");
  });

  it("exports only the first terminal for a replay-stable span", () => {
    const downstream = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [downstream] },
        serviceName: "weather",
      }),
    ).toThrow();

    const processor = (
      registerOTel.mock.calls.at(-1)![0] as {
        spanProcessors: { onEnd(span: unknown): void }[];
      }
    ).spanProcessors[0]!;
    const first = replaySpan("first");
    const losingReplay = replaySpan("losing replay");
    processor.onEnd(first);
    processor.onEnd(losingReplay);

    expect(downstream.onEnd).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("holds a physical child until its started parent completes", () => {
    const downstream = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    registerOTel.mockImplementation(() => undefined);
    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [downstream] },
        serviceName: "weather",
      }),
    ).toThrow();
    const processor = (
      registerOTel.mock.calls.at(-1)![0] as {
        spanProcessors: {
          onEnd(span: unknown): void;
          onStart(span: unknown, parentContext: unknown): void;
        }[];
      }
    ).spanProcessors[0]!;
    const parent = physicalSpan("2");
    const child = physicalSpan("3", "2");
    processor.onStart(parent, {});
    processor.onStart(child, {});
    processor.onEnd(child);
    expect(downstream.onEnd).not.toHaveBeenCalled();

    processor.onEnd(parent);
    expect(downstream.onEnd.mock.calls).toEqual([[parent], [child]]);
  });

  it("throws when the registration never reached a processor", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({ pipeline: { spanProcessors: [] }, serviceName: "weather" }),
    ).toThrow(/another runtime already owns/u);
  });

  it("drains held children on flush when their parent never ends", async () => {
    const { downstream, processor } = filteringProcessor();
    const parent = physicalSpan("2");
    const child = physicalSpan("3", "2");
    processor.onStart(parent, {});
    processor.onStart(child, {});
    processor.onEnd(child);
    expect(downstream.onEnd).not.toHaveBeenCalled();

    await processor.forceFlush();

    expect(downstream.onEnd).toHaveBeenCalledExactlyOnceWith(child);
    expect(downstream.forceFlush).toHaveBeenCalledOnce();
    expect(downstream.onEnd.mock.invocationCallOrder[0]).toBeLessThan(
      downstream.forceFlush.mock.invocationCallOrder[0]!,
    );
  });

  it("drains held children at shutdown", async () => {
    const { downstream, processor } = filteringProcessor();
    const parent = physicalSpan("2");
    const child = physicalSpan("3", "2");
    processor.onStart(parent, {});
    processor.onStart(child, {});
    processor.onEnd(child);

    await processor.shutdown();

    expect(downstream.onEnd).toHaveBeenCalledExactlyOnceWith(child);
    expect(downstream.shutdown).toHaveBeenCalledOnce();
  });

  it("does not re-forward drained children when the parent ends later", async () => {
    const { downstream, processor } = filteringProcessor();
    const parent = physicalSpan("2");
    const child = physicalSpan("3", "2");
    processor.onStart(parent, {});
    processor.onStart(child, {});
    processor.onEnd(child);
    await processor.forceFlush();

    processor.onEnd(parent);

    expect(downstream.onEnd.mock.calls).toEqual([[child], [parent]]);
  });

  it("releases held children once one stuck parent exceeds the pending cap", () => {
    const { downstream, processor } = filteringProcessor();
    const parent = physicalSpan("2");
    processor.onStart(parent, {});
    const overflow = 10_001;
    for (let index = 0; index < overflow; index += 1) {
      const child = {
        parentSpanContext: { spanId: "2".repeat(16), traceId: "1".repeat(32) },
        spanContext: () => ({
          spanId: index.toString(16).padStart(16, "0"),
          traceId: "1".repeat(32),
        }),
      };
      processor.onStart(child, {});
      processor.onEnd(child);
    }

    expect(downstream.onEnd).toHaveBeenCalledTimes(overflow);
  });
});

function filteringProcessor() {
  const downstream = {
    forceFlush: vi.fn(async () => {}),
    onEnd: vi.fn(),
    onStart: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  registerOTel.mockImplementation(() => undefined);
  expect(() =>
    registerOtelPipeline({
      pipeline: { spanProcessors: [downstream] },
      serviceName: "weather",
    }),
  ).toThrow();
  const processor = (
    registerOTel.mock.calls.at(-1)![0] as {
      spanProcessors: {
        forceFlush(): Promise<void>;
        onEnd(span: unknown): void;
        onStart(span: unknown, parentContext: unknown): void;
        shutdown(): Promise<void>;
      }[];
    }
  ).spanProcessors[0]!;
  return { downstream, processor };
}

function replaySpan(marker: string) {
  return {
    marker,
    spanContext: () => ({ spanId: "2".repeat(16), traceId: "1".repeat(32) }),
  };
}

function physicalSpan(spanId: string, parentSpanId?: string) {
  const traceId = "1".repeat(32);
  return {
    parentSpanContext:
      parentSpanId === undefined ? undefined : { spanId: parentSpanId.repeat(16), traceId },
    spanContext: () => ({ spanId: spanId.repeat(16), traceId }),
  };
}
