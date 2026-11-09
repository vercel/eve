import {
  context as apiContext,
  diag,
  DiagLogLevel,
  propagation as apiPropagation,
  trace as apiTrace,
} from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSpanIdGenerator } from "#compiled/@vercel/agent-runs/index.js";
import { trace as vendoredTrace } from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { traceChannelRequest } from "#internal/nitro/routes/channel-request-instrumentation.js";

// These tests run through the bundled `@vercel/otel` registration (its composite
// span processor) with a diag logger, so a span ended twice is observable. A plain
// `BasicTracerProvider` silently ignores a second `end()`.
const DOUBLE_END = "You can only call end() on a span once";

describe("traceChannelRequest span lifetime", () => {
  let exporter: InMemorySpanExporter;
  let errors: string[];

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    errors = [];
    diag.setLogger(
      {
        error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
        warn() {},
        info() {},
        debug() {},
        verbose() {},
      },
      DiagLogLevel.ERROR,
    );
    registerOTel({
      serviceName: "request-span-lifetime",
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
    } as never);
    registerInstrumentationRuntime({
      forceFlush: async () => undefined,
      idGenerator: new AgentSpanIdGenerator(),
      hooks: createInstrumentationHooks([]),
      otelSettings: {
        functionId: undefined,
        recordInputs: false,
        recordOutputs: false,
        traceChannelRequests: true,
      },
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    });
  });

  afterEach(() => {
    apiTrace.disable();
    apiContext.disable();
    apiPropagation.disable();
    diag.disable();
  });

  function trace(handler: () => Response): Promise<Response> {
    return traceChannelRequest(
      { request: new Request("https://eve.test/eve/v1/session/s/stream"), routeKey: "GET /stream" },
      async () => handler(),
    );
  }

  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // The request span ends when the body's pipe settles, a microtask after the reader sees it close.
  const requestSpans = () =>
    exporter.getFinishedSpans().filter((span) => span.name === "agent.channel.request");

  // https://github.com/vercel/eve/issues/4256: the stream route's run lookup and
  // `workflow.stream.read.connect` start while the lazy body is read and end
  // out of order.
  it("ends overlapping spans started while the body is read exactly once", async () => {
    const response = await trace(
      () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              const tracer = vendoredTrace.getTracer("test");
              const lookup = tracer.startSpan("http GET");
              const connect = tracer.startSpan("workflow.stream.read.connect");
              await tick(5);
              lookup.end();
              await tick(5);
              connect.end();
              controller.enqueue(new TextEncoder().encode("event"));
              controller.close();
            },
          }),
        ),
    );
    expect(await response.text()).toBe("event");

    await vi.waitFor(() => expect(requestSpans()).toHaveLength(1));
    expect(errors.filter((error) => error.includes(DOUBLE_END))).toEqual([]);
  });

  it("ends the request span exactly once when the client cancels a pending read", async () => {
    const response = await trace(
      () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) })),
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    await tick(5);
    await reader.cancel("client gone");
    await pending;

    await vi.waitFor(() => expect(requestSpans()).toHaveLength(1));
    expect(errors.filter((error) => error.includes(DOUBLE_END))).toEqual([]);
  });
});
