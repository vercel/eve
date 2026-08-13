import { describe, expect, it, vi } from "vitest";
import {
  BasicTracerProvider,
  type SpanProcessor as OpenTelemetrySpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { contentFilteringProcessor } from "#tracing/content-span-processor.js";

function recordingProcessor(): SpanProcessor & {
  readonly ended: unknown[];
  readonly started: unknown[];
} {
  const ended: unknown[] = [];
  const started: unknown[] = [];
  return {
    ended,
    forceFlush: () => Promise.resolve(),
    onEnd: (span) => {
      ended.push(span);
    },
    onStart: (span) => {
      started.push(span);
    },
    started,
    shutdown: () => Promise.resolve(),
  };
}

function span(attributes: Record<string, unknown>): unknown {
  return {
    attributes,
    spanContext: () => ({ spanId: "span", traceId: "trace" }),
  };
}

describe("contentFilteringProcessor", () => {
  it("forwards the span untouched when the destination declined nothing", () => {
    const downstream = recordingProcessor();
    const original = span({ "ai.prompt.messages": "what the user said" });

    contentFilteringProcessor(downstream, { recordInputs: true, recordOutputs: true }).onEnd(
      original as never,
    );

    expect(downstream.ended).toEqual([original]);
  });

  it("forwards a copy without what the destination declined", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, { recordInputs: false, recordOutputs: true }).onEnd(
      span({
        "ai.prompt.messages": "what the user said",
        "ai.response.text": "what the model said",
      }) as never,
    );

    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "ai.response.text": "what the model said",
    });
  });

  it("leaves the original span's attributes in place for the other destinations", () => {
    const kept = recordingProcessor();
    const declined = recordingProcessor();
    const original = span({ "ai.prompt.messages": "what the user said" });

    contentFilteringProcessor(declined, { recordInputs: false, recordOutputs: false }).onEnd(
      original as never,
    );
    kept.onEnd(original as never);

    expect((declined.ended[0] as { attributes: unknown }).attributes).toEqual({});
    expect((kept.ended[0] as { attributes: unknown }).attributes).toEqual({
      "ai.prompt.messages": "what the user said",
    });
  });

  it("keeps the rest of the span surface reachable on the copy", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, { recordInputs: false, recordOutputs: false }).onEnd(
      span({ "ai.prompt.messages": "what the user said" }) as never,
    );

    expect((downstream.ended[0] as { spanContext: () => unknown }).spanContext()).toEqual({
      spanId: "span",
      traceId: "trace",
    });
  });

  it("withholds exception details when outputs are declined", () => {
    const downstream = recordingProcessor();
    const original = {
      ...(span({ "service.name": "weather" }) as object),
      events: [
        { attributes: { "exception.message": "private output" }, name: "exception" },
        { attributes: { detail: "private event data" }, name: "turn.completed" },
      ],
      status: { code: 2, message: "private failure detail" },
    };

    contentFilteringProcessor(downstream, { recordInputs: true, recordOutputs: false }).onEnd(
      original as never,
    );

    const visible = downstream.ended[0] as {
      events: unknown[];
      status: unknown;
    };
    expect(visible.events).toEqual([{ attributes: undefined, name: "turn.completed" }]);
    expect(visible.status).toEqual({ code: 2 });
    expect(original.events).toHaveLength(2);
    expect(original.status).toEqual({ code: 2, message: "private failure detail" });
  });

  it("redacts initial attributes before onStart without exposing the original", () => {
    const downstream = recordingProcessor();
    const original = span({
      "ai.prompt.messages": "what the user said",
      "service.name": "weather",
    });

    contentFilteringProcessor(downstream, { recordInputs: false, recordOutputs: true }).onStart(
      original as never,
      undefined as never,
    );

    expect(downstream.started[0]).not.toBe(original);
    expect((downstream.started[0] as { attributes: unknown }).attributes).toEqual({
      "service.name": "weather",
    });
    expect((original as { attributes: unknown }).attributes).toHaveProperty(
      "ai.prompt.messages",
      "what the user said",
    );
  });

  it("reuses and refreshes one facade from onStart through onEnd", () => {
    const downstream = recordingProcessor();
    const original = span({
      "ai.prompt.messages": "what the user said",
      "service.name": "weather",
    }) as { attributes: Record<string, unknown> };
    const processor = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: true,
    });

    processor.onStart(original as never, undefined as never);
    const retainedAttributes = (downstream.started[0] as { attributes: unknown }).attributes;
    original.attributes["ai.response.text"] = "what the model said";
    processor.onEnd(original as never);

    expect(downstream.started[0]).toBe(downstream.ended[0]);
    expect((downstream.ended[0] as { attributes: unknown }).attributes).toBe(retainedAttributes);
    expect((downstream.started[0] as { attributes: unknown }).attributes).toEqual({
      "ai.response.text": "what the model said",
      "service.name": "weather",
    });
  });

  it("keeps SDK methods bound to the original span", () => {
    let original: {
      attributes: Record<string, unknown>;
      fluent(): unknown;
      setAttribute(key: string, value: unknown): unknown;
      spanContext(): unknown;
    };
    original = {
      attributes: { "ai.prompt.messages": "what the user said" },
      fluent() {
        return this;
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
        return this;
      },
      spanContext() {
        if (this !== original) throw new Error("wrong span receiver");
        return { spanId: "span", traceId: "trace" };
      },
    };
    const downstream = recordingProcessor();
    const processor = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: true,
    });

    processor.onStart(original as never, undefined as never);

    expect((downstream.started[0] as { spanContext(): unknown }).spanContext()).toEqual({
      spanId: "span",
      traceId: "trace",
    });
    expect((downstream.started[0] as { fluent(): unknown }).fluent()).toBe(downstream.started[0]);
    expect((downstream.started[0] as { valueOf(): unknown }).valueOf()).toBe(downstream.started[0]);
    const facade = downstream.started[0] as {
      attributes: Record<string, unknown>;
      setAttribute(key: string, value: unknown): unknown;
    };
    expect(facade.setAttribute("service.name", "weather")).toBe(facade);
    expect(facade.attributes["service.name"]).toBe("weather");
  });

  it("continues refreshing after a processor freezes the facade", () => {
    const downstream = recordingProcessor();
    const original = span({ "ai.prompt.messages": "what the user said" }) as {
      attributes: Record<string, unknown>;
    };
    const processor = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: true,
    });

    processor.onStart(original as never, undefined as never);
    Object.freeze(downstream.started[0]);
    original.attributes["ai.response.text"] = "what the model said";

    expect(() => processor.onEnd(original as never)).not.toThrow();
    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "ai.response.text": "what the model said",
    });
  });

  it("facades a real OpenTelemetry span across both callbacks", () => {
    const downstream = recordingProcessor();
    const filtering = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: true,
    });
    const provider = new BasicTracerProvider({
      spanProcessors: [filtering as OpenTelemetrySpanProcessor],
    });
    const span = provider.getTracer("test").startSpan("test", {
      attributes: { "ai.prompt.messages": "what the user said" },
    });

    span.setAttribute("ai.response.text", "what the model said");
    span.end();

    expect(downstream.started[0]).toBe(downstream.ended[0]);
    expect((downstream.started[0] as { spanContext(): unknown }).spanContext()).toEqual(
      span.spanContext(),
    );
    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "ai.response.text": "what the model said",
    });
  });

  it("preserves local trace session release through the wrapper", async () => {
    const releaseSession = vi.fn(async () => true);
    const downstream: SpanProcessor & {
      releaseSession(sessionId: string): Promise<boolean>;
    } = { ...recordingProcessor(), releaseSession };
    const processor = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: false,
    }) as SpanProcessor & { releaseSession(sessionId: string): Promise<boolean> };

    await expect(processor.releaseSession("session-1")).resolves.toBe(true);
    expect(releaseSession).toHaveBeenCalledExactlyOnceWith("session-1");
  });
});
