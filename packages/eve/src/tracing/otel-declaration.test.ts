import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { describe, expect, it } from "vitest";

import {
  agentRunsIntegration,
  collectOtelPipeline,
  isOtelDeclaration,
  isOtelIntegration,
  managedOtelIntegration,
  otel,
  otelIntegration,
} from "#tracing/otel-declaration.js";
import { composeSpanExportPolicies, redactSpanInputs } from "#tracing/span-export-policy.js";

/** Collection only ever moves processors, so a fresh no-op is identity enough. */
function processor(): SpanProcessor {
  return {
    forceFlush: async () => undefined,
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: async () => undefined,
  };
}

function exporter(): SpanExporter {
  return {
    export: (_spans, resultCallback) => {
      resultCallback({ code: 0 });
    },
    shutdown: async () => undefined,
  };
}

function testSpan(attributes: Record<string, unknown>): never {
  return {
    attributes,
    name: "agent.step",
    spanContext: () => ({ spanId: "span", traceId: "trace" }),
  } as never;
}

describe("otel", () => {
  it("declares settings without registering anything", () => {
    const declaration = otel({ sampler: "always_on" });
    expect(isOtelDeclaration(declaration)).toBe(true);
    expect(isOtelDeclaration({ options: {} })).toBe(false);
  });
});

describe("otelIntegration", () => {
  it("passes declared processors through untouched", () => {
    const first = processor();
    const integration = otelIntegration({
      spanProcessors: [first],
    });

    expect(isOtelIntegration(integration)).toBe(true);
    expect(integration.spanProcessors).toStrictEqual([first]);
  });

  it("wraps an exporter in a batching processor, after any declared ones", () => {
    const first = processor();
    const integration = otelIntegration({
      spanProcessors: [first],
      traceExporter: exporter(),
    });

    expect(integration.spanProcessors).toHaveLength(2);
    expect(integration.spanProcessors[0]).toBe(first);
  });

  it("maps deprecated capture switches to destination redaction", () => {
    const first = processor();
    const integration = otelIntegration({ recordInputs: false, spanProcessors: [first] });

    expect(integration.content).toEqual({ recordInputs: false, recordOutputs: true });
    expect(integration.spanProcessors[0]).not.toBe(first);
  });
});

describe("agentRunsIntegration", () => {
  it("declares the Agent Runs runtime processor", () => {
    const integration = agentRunsIntegration();

    expect(integration.spanProcessors).toHaveLength(1);
    expect(integration.spanProcessors[0]).not.toBe("auto");
  });
});

describe("managed export policy", () => {
  it("does not redact content unless the export pipeline requests it", () => {
    let visibleAttributes: Readonly<Record<string, unknown>> | undefined;
    const integration = managedOtelIntegration({
      exportPolicy: {
        span: ({ attributes }) => {
          visibleAttributes = attributes;
          return true;
        },
      },
      spanProcessors: [processor()],
    });

    const spanProcessor = integration.spanProcessors[0];
    if (spanProcessor === undefined || spanProcessor === "auto") throw new Error("Expected policy");
    spanProcessor.onEnd(
      testSpan({
        "agent.channel.audience": "private",
        "ai.prompt.messages": "private input",
      }),
    );

    expect(visibleAttributes).toHaveProperty("ai.prompt.messages", "private input");
  });

  it("runs composed export policies in declaration order", () => {
    let visibleAttributes: Readonly<Record<string, unknown>> | undefined;
    const integration = managedOtelIntegration({
      exportPolicy: composeSpanExportPolicies(
        redactSpanInputs(({ attributes }) => attributes["visibility"] !== "public"),
        {
          span: ({ attributes }) => {
            visibleAttributes = attributes;
            return true;
          },
        },
      ),
      spanProcessors: [processor()],
    });

    const spanProcessor = integration.spanProcessors[0];
    if (spanProcessor === undefined || spanProcessor === "auto") throw new Error("Expected policy");
    spanProcessor.onEnd(
      testSpan({
        visibility: "private",
        "ai.prompt.messages": "private input",
      }),
    );

    expect(visibleAttributes).toEqual({ visibility: "private" });
  });

  it("applies deprecated content switches before the configured export policy", () => {
    let visibleAttributes: Readonly<Record<string, unknown>> | undefined;
    const integration = managedOtelIntegration({
      exportPolicy: {
        span: ({ attributes }) => {
          visibleAttributes = attributes;
          return true;
        },
      },
      recordInputs: false,
      spanProcessors: [processor()],
    });

    const spanProcessor = integration.spanProcessors[0];
    if (spanProcessor === undefined || spanProcessor === "auto") throw new Error("Expected policy");
    spanProcessor.onEnd(testSpan({ "ai.prompt.messages": "private input" }));

    expect(visibleAttributes).toEqual({});
  });
});

describe("collectOtelPipeline", () => {
  it("reports nothing declared when nothing did", () => {
    expect(collectOtelPipeline([]).declared).toBe(false);
    expect(collectOtelPipeline([{ not: "a declaration" }]).declared).toBe(false);
  });

  it("concatenates destinations in declaration order", () => {
    const [first, second, third] = [processor(), processor(), processor()];
    const collected = collectOtelPipeline([
      otelIntegration({
        spanProcessors: [first, second],
      }),
      otelIntegration({ spanProcessors: [third] }),
      otel(),
    ]);

    expect(collected.declared).toBe(true);
    expect(collected.pipeline.spanProcessors).toStrictEqual([first, second, third]);
  });

  it("is declared by a destination alone, with no otel() beside it", () => {
    const collected = collectOtelPipeline([otelIntegration({ spanProcessors: [processor()] })]);

    expect(collected.declared).toBe(true);
    expect(collected.settings).toStrictEqual({
      functionId: undefined,
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    });
  });

  it("carries the singletons onto the pipeline and the rest onto the settings", () => {
    const collected = collectOtelPipeline([
      otel({
        functionId: "weather",
        propagators: ["tracecontext"],
        resource: { "service.version": "abc" },
        sampler: "always_on",
        traceChannelRequests: true,
      }),
    ]);

    expect(collected.pipeline).toMatchObject({
      propagators: ["tracecontext"],
      resource: { "service.version": "abc" },
      sampler: "always_on",
    });
    expect(collected.settings).toStrictEqual({
      functionId: "weather",
      // Nothing declared a destination, so nothing consumes content.
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: true,
    });
  });

  it("captures complete spans whenever a destination is declared", () => {
    const collected = collectOtelPipeline([otelIntegration()]);

    expect(collected.settings).toMatchObject({ recordInputs: true, recordOutputs: true });
  });

  // A process has one tracer provider, so letting the first declaration win
  // would silently discard the second — the failure this throw exists to stop.
  it("refuses a second otel() rather than picking one", () => {
    expect(() =>
      collectOtelPipeline([otel({ sampler: "always_on" }), otel({ sampler: "always_off" })]),
    ).toThrow(/declares `otel\(\)` more than once/u);
  });

  it("passes declared instrumentations onto the pipeline", () => {
    const instrumentation = { name: "test-instrumentation" };
    const collected = collectOtelPipeline([otel({ instrumentations: [instrumentation] })]);

    expect(collected.pipeline.instrumentations).toStrictEqual([instrumentation]);
  });

  it("defaults to undefined instrumentations when none are declared", () => {
    const collected = collectOtelPipeline([otel()]);

    expect(collected.pipeline.instrumentations).toBeUndefined();
  });
});
