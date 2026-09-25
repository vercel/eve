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
    const original = span({ "gen_ai.input.messages": "what the user said" });

    contentFilteringProcessor(downstream).onEnd(original as never);

    expect(downstream.ended).toEqual([original]);
  });

  it("forwards a copy without what the destination declined", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true }),
    }).onEnd(
      span({
        "gen_ai.input.messages": "what the user said",
        "ai.response.text": "what the model said",
      }) as never,
    );

    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "ai.response.text": "what the model said",
    });
  });

  it("drops the span when its policy throws", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, {
      span: () => {
        throw new Error("policy failed");
      },
    }).onEnd(
      span({
        "gen_ai.input.messages": "what the user said",
        "service.name": "weather",
      }) as never,
    );

    expect(downstream.ended).toEqual([]);
  });

  it("drops the span when a redaction decision names no direction", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, {
      span: () => ({ redact: true }) as never,
    }).onEnd(span({ "gen_ai.input.messages": "what the user said" }) as never);

    expect(downstream.ended).toEqual([]);
  });

  it("drops the span when one decision combines emission and redaction", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, {
      span: () => ({ emit: true, redact: true, inputs: true }) as never,
    }).onEnd(span({ "gen_ai.input.messages": "what the user said" }) as never);

    expect(downstream.ended).toEqual([]);
  });

  it("reports the content policy visible to each destination", () => {
    const downstream = recordingProcessor();
    const original = span({
      "agent.trace.content.input": true,
      "agent.trace.content.output": true,
      "gen_ai.input.messages": "what the user said",
    });

    contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true }),
    }).onEnd(original as never);

    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "agent.trace.content.input": false,
      "agent.trace.content.output": true,
    });
    expect((original as { attributes: unknown }).attributes).toEqual({
      "agent.trace.content.input": true,
      "agent.trace.content.output": true,
      "gen_ai.input.messages": "what the user said",
    });
  });

  it("leaves the original span's attributes in place for the other destinations", () => {
    const kept = recordingProcessor();
    const declined = recordingProcessor();
    const original = span({ "gen_ai.input.messages": "what the user said" });

    contentFilteringProcessor(declined, {
      span: () => ({ redact: true, inputs: true, outputs: true }),
    }).onEnd(original as never);
    kept.onEnd(original as never);

    expect((declined.ended[0] as { attributes: unknown }).attributes).toEqual({});
    expect((kept.ended[0] as { attributes: unknown }).attributes).toEqual({
      "gen_ai.input.messages": "what the user said",
    });
  });

  it("keeps the rest of the span surface reachable on the copy", () => {
    const downstream = recordingProcessor();

    contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true, outputs: true }),
    }).onEnd(span({ "gen_ai.input.messages": "what the user said" }) as never);

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

    contentFilteringProcessor(downstream, {
      span: ({ name }) => ({ redact: true, outputs: name !== "metadata" }),
    }).onEnd(original as never);

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
      "gen_ai.input.messages": "what the user said",
      "service.name": "weather",
    });

    contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true }),
    }).onStart(original as never, undefined as never);

    expect(downstream.started[0]).not.toBe(original);
    expect((downstream.started[0] as { attributes: unknown }).attributes).toEqual({
      "service.name": "weather",
    });
    expect((original as { attributes: unknown }).attributes).toHaveProperty(
      "gen_ai.input.messages",
      "what the user said",
    );
  });

  it("reuses and refreshes one facade from onStart through onEnd", () => {
    const downstream = recordingProcessor();
    const original = span({
      "gen_ai.input.messages": "what the user said",
      "service.name": "weather",
    }) as { attributes: Record<string, unknown> };
    const processor = contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true }),
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
      attributes: { "gen_ai.input.messages": "what the user said" },
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
      span: () => ({ redact: true, inputs: true }),
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
    const original = span({ "gen_ai.input.messages": "what the user said" }) as {
      attributes: Record<string, unknown>;
    };
    const processor = contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true }),
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
      span: () => ({ redact: true, inputs: true }),
    });
    const provider = new BasicTracerProvider({
      spanProcessors: [filtering as OpenTelemetrySpanProcessor],
    });
    const span = provider.getTracer("test").startSpan("test", {
      attributes: { "gen_ai.input.messages": "what the user said" },
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

  it.each([
    ["public", true],
    ["private", false],
    ["unknown", false],
  ] as const)("retains content for the %s audience: %s", (audience, retained) => {
    const downstream = recordingProcessor();
    contentFilteringProcessor(downstream, {
      span: ({ audience }) =>
        audience === "public" ? { emit: true } : { redact: true, inputs: true, outputs: true },
    }).onEnd(
      span({
        "agent.channel.audience": audience,
        "gen_ai.input.messages": "input",
        "ai.response.text": "output",
      }) as never,
    );

    const expected: Record<string, unknown> = { "agent.channel.audience": audience };
    if (retained) {
      expected["gen_ai.input.messages"] = "input";
      expected["ai.response.text"] = "output";
    }
    expect((downstream.ended[0] as { attributes: Record<string, unknown> }).attributes).toEqual(
      expected,
    );
  });

  it("fails closed when audience attributes disagree", () => {
    const downstream = recordingProcessor();
    contentFilteringProcessor(downstream, {
      span: ({ audience }) =>
        audience === "public" ? { emit: true } : { redact: true, inputs: true, outputs: true },
    }).onEnd(
      span({
        "agent.channel.audience": "public",
        "gen_ai.input.messages": "private",
        "ai.settings.context.eve.channel.audience": "private",
      }) as never,
    );

    expect(
      (downstream.ended[0] as { attributes: Record<string, unknown> }).attributes,
    ).not.toHaveProperty("gen_ai.input.messages");
  });

  it("passes only attributes visible after earlier policy stages", () => {
    const downstream = recordingProcessor();
    const keys: string[] = [];

    contentFilteringProcessor(downstream, [
      { span: () => ({ redact: true, inputs: true }) },
      {
        attribute: ({ key }) => {
          keys.push(key);
          return { emit: true };
        },
      },
    ]).onEnd(
      span({
        "gen_ai.input.messages": "private input",
        "service.name": "weather",
      }) as never,
    );

    expect(keys).not.toContain("gen_ai.input.messages");
    expect(keys).toContain("service.name");
    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      "service.name": "weather",
    });
  });

  it("can drop an individual span", () => {
    const downstream = recordingProcessor();
    contentFilteringProcessor(downstream, {
      span: ({ name }) => ({ emit: name !== "private-work" }),
    }).onEnd({
      ...(span({}) as object),
      name: "private-work",
    } as never);

    expect(downstream.ended).toEqual([]);
  });

  it("can drop and replace individual attributes", () => {
    const downstream = recordingProcessor();
    contentFilteringProcessor(downstream, {
      attribute: ({ key }) =>
        key === "secret"
          ? { emit: false }
          : key === "email"
            ? { replace: true, value: "[redacted]" }
            : key === "ambiguous"
              ? ({ emit: false, replace: true, value: "replacement" } as never)
              : key === "missing"
                ? ({ replace: true } as never)
                : { emit: true },
    }).onEnd(
      span({
        ambiguous: "original",
        email: "ada@example.com",
        missing: "value",
        secret: "value",
      }) as never,
    );

    expect((downstream.ended[0] as { attributes: unknown }).attributes).toEqual({
      email: "[redacted]",
    });
  });

  it("preserves local trace session release through the wrapper", async () => {
    const releaseConversation = vi.fn(async () => true);
    const downstream: SpanProcessor & {
      releaseConversation(sessionId: string): Promise<boolean>;
    } = { ...recordingProcessor(), releaseConversation };
    const processor = contentFilteringProcessor(downstream, {
      span: () => ({ redact: true, inputs: true, outputs: true }),
    }) as SpanProcessor & { releaseConversation(sessionId: string): Promise<boolean> };

    await expect(processor.releaseConversation("session-1")).resolves.toBe(true);
    expect(releaseConversation).toHaveBeenCalledExactlyOnceWith("session-1");
  });
});
