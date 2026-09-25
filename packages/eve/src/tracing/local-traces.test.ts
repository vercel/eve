import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultEveAudience } from "#eve-channel/audience.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { localTracePolicy } from "#tracing/local-instrumentation-runtime.js";
import {
  createLocalTracesProcessor,
  resolveLocalTracesExportPolicy,
} from "#tracing/local-traces.js";
import { resolveTracePolicy } from "#tracing/sampled-trace.js";
import { localTraces } from "#public/instrumentation/otel.js";

vi.mock("#tracing/local-trace-span-processor.js", () => ({
  LocalTraceSpanProcessor: class {
    async forceFlush(): Promise<void> {}
    onEnd(): void {}
    onStart(): void {}
    async shutdown(): Promise<void> {}
  },
}));

vi.mock("#tracing/local-trace-retention.js", () => ({
  requestLocalTraceStorePrune: vi.fn(),
  resolveLocalTraceRetentionSettings: () => ({
    enabled: true,
    maxAgeMs: 1,
    maxTotalBytes: 1,
    retainCount: 1,
  }),
}));

function agentSpan(sessionId: string, traceId: string): unknown {
  return {
    attributes: { "gen_ai.conversation.id": sessionId },
    spanContext: () => ({ traceId }),
  };
}

const traceContext = (audience: "public" | "private" | "unknown") => ({
  agentName: "weather",
  audience,
  channel: { kind: "http" as const },
  environment: "development" as const,
  mode: "conversation" as const,
  principalType: "user",
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createLocalTracesProcessor", () => {
  it("reports whether the released session owned any traces", async () => {
    const spool = createLocalTracesProcessor({ appRoot: "/tmp/eve-local-traces-test" });
    spool.onStart(agentSpan("session-one", "a".repeat(32)), undefined);

    // A subagent child owns none, so releasing it leaves the trace pinned.
    await expect(spool.releaseConversation("child-one")).resolves.toBe(false);
    await expect(spool.releaseConversation("session-one")).resolves.toBe(true);
    // Releasing twice is not an error, it just owns nothing the second time.
    await expect(spool.releaseConversation("session-one")).resolves.toBe(false);
  });

  it("is a span processor, so it composes wherever one goes", () => {
    const spool = createLocalTracesProcessor({ appRoot: "/tmp/eve-local-traces-test" });
    expect(typeof spool.onStart).toBe("function");
    expect(typeof spool.onEnd).toBe("function");
    expect(typeof spool.forceFlush).toBe("function");
    expect(typeof spool.shutdown).toBe("function");
  });

  it("is inert outside a development worker", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    const [processor] = localTraces().spanProcessors;
    if (processor === undefined || processor === "auto") throw new Error("Expected a processor.");

    expect(() => processor.onEnd(agentSpan("session-one", "a".repeat(32)))).not.toThrow();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});

describe("resolveLocalTracesExportPolicy", () => {
  it("preserves the authored policy by default", () => {
    const exportPolicy = { span: () => ({ emit: true }) } as const;

    expect(resolveLocalTracesExportPolicy(exportPolicy)).toBe(exportPolicy);
  });

  it("preserves the authored policy when EVE_TRACES_CONTENT=on", () => {
    vi.stubEnv("EVE_TRACES_CONTENT", "on");
    const exportPolicy = { span: () => ({ emit: true }) } as const;

    expect(resolveLocalTracesExportPolicy(exportPolicy)).toBe(exportPolicy);
  });

  it("prepends full redaction when EVE_TRACES_CONTENT=off", () => {
    vi.stubEnv("EVE_TRACES_CONTENT", "off");
    let visibleAttributes: Readonly<Record<string, unknown>> | undefined;
    const exportPolicy = resolveLocalTracesExportPolicy({
      span: ({ attributes }) => {
        visibleAttributes = attributes;
        return { emit: true };
      },
    });

    contentFilteringProcessor(
      {
        forceFlush: async () => undefined,
        onEnd: () => undefined,
        onStart: () => undefined,
        shutdown: async () => undefined,
      },
      exportPolicy,
    ).onEnd({
      attributes: {
        "ai.response.text": "private output",
        "gen_ai.input.messages": "private input",
      },
      spanContext: () => ({ spanId: "span", traceId: "trace" }),
    } as never);

    expect(visibleAttributes).toEqual({});
  });
});

describe("localTracePolicy", () => {
  it("records an authenticated development session classified as private", () => {
    const audience = defaultEveAudience({
      auth: {
        attributes: {},
        authenticator: "vercel-oidc",
        principalType: "user",
      },
      caller: {
        type: "principal",
        principal: {
          attributes: {},
          authenticator: "vercel-oidc",
          kind: "user",
        },
      },
      channel: { kind: "http" },
      environment: "development",
      mode: "conversation",
    });

    expect(audience).toBe("private");
    expect(resolveTracePolicy(localTracePolicy, traceContext(audience))).toEqual({
      action: "record",
      recordInputs: true,
      recordOutputs: true,
    });
  });
});
