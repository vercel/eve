import { describe, expect, it } from "vitest";
import type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";
import {
  planSessionInstrumentation,
  parseSessionInstrumentationPlan,
  readPlanTraceId,
  readPlanIsTraceContentVisible,
  readPlanChannelKind,
  readPlanTraceContext,
  type InstrumentationPlanningRuntime,
  type SessionInstrumentationPlanningInput,
} from "#instrumentation/session-plan.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

function makeRuntime(
  overrides: Partial<InstrumentationPlanningRuntime> = {},
): InstrumentationPlanningRuntime {
  return {
    idGenerator: {
      allocateSpanId: () => "0123456789abcdef",
      generateTraceId: () => "0123456789abcdef0123456789abcdef",
    },
    otelSettings: {
      tracePolicy: () => true,
      recordInputs: false,
      recordOutputs: false,
    },
    hooks: { capturesContent: false },
    prepareSessionTrace: () => undefined,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionInstrumentationPlanningInput> = {},
): SessionInstrumentationPlanningInput {
  return {
    agentName: "test-agent",
    channel: {
      channelType: "web",
      kind: "web",
      metadata: { audience: "public" },
    },
    rootSessionId: "session-1",
    ...overrides,
  };
}

describe("planSessionInstrumentation", () => {
  describe("root session", () => {
    it("evaluates tracePolicy and allocates trace identity", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession(),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(true);
      expect(data?.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(data?.spanId).toBe("0123456789abcdef");
      expect(data?.traceFlags).toBe(1);
    });

    it("returns unsampled plan when policy returns false", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => false } }),
        session: makeSession(),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(false);
      expect(data?.traceFlags).toBe(0);
    });

    it("fails closed when policy throws", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({
          otelSettings: {
            tracePolicy: () => {
              throw new Error("boom");
            },
          },
        }),
        session: makeSession(),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(false);
    });

    it("defaults to public-audience admission when no policy is set", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: {} }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "public" } },
        }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(true);
    });

    it("defaults to rejected when no policy is set and audience is private", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: {} }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(false);
    });
  });

  describe("local subagent inheritance", () => {
    it("inherits the parent trace context without re-evaluating policy", () => {
      const parentTraceContext = {
        traceId: "parent-trace-id",
        spanId: "parent-span-id",
        traceFlags: 1,
      };
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => false } }),
        session: makeSession({
          parentTraceContext,
          parentLineage: { callId: "call-1", sessionId: "parent-1", turnId: "turn_1" },
          rootSessionId: "parent-1",
        }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.traceId).toBe("parent-trace-id");
      expect(data?.spanId).toBe("parent-span-id");
      expect(data?.traceFlags).toBe(1);
      expect(data?.sampled).toBe(true);
    });

    it("inherits unsampled parent without promoting to sampled", () => {
      const parentTraceContext = {
        traceId: "parent-trace-id",
        spanId: "parent-span-id",
        traceFlags: 0,
      };
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession({ parentTraceContext }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(false);
      expect(data?.traceFlags).toBe(0);
    });
  });

  describe("no instrumentation runtime", () => {
    it("produces an inert plan", () => {
      const plan = planSessionInstrumentation({
        runtime: undefined,
        session: makeSession(),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(false);
      expect(data?.traceId).toBe("");
      expect(data?.spanId).toBe("");
      expect(data?.captureLevel).toBe("metadata");
    });
  });

  describe("producer capture level", () => {
    it("is content when trace is sampled", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession(),
      });
      expect(parseSessionInstrumentationPlan(plan)?.captureLevel).toBe("content");
    });

    it("is content when legacy recordInputs is true even if unsampled", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({
          otelSettings: { tracePolicy: () => false, recordInputs: true },
        }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      expect(parseSessionInstrumentationPlan(plan)?.captureLevel).toBe("content");
    });

    it("is content when an authored provider captures content even if unsampled", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({
          otelSettings: { tracePolicy: () => false },
          hooks: { capturesContent: true },
        }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      expect(parseSessionInstrumentationPlan(plan)?.captureLevel).toBe("content");
    });

    it("is metadata when unsampled and no provider requests content", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => false } }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      expect(parseSessionInstrumentationPlan(plan)?.captureLevel).toBe("metadata");
    });
  });

  describe("workflow visibility", () => {
    it("is true for public audience", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime(),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "public" } },
        }),
      });
      expect(readPlanIsTraceContentVisible(plan)).toBe(true);
    });

    it("is false for private audience", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime(),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      expect(readPlanIsTraceContentVisible(plan)).toBe(false);
    });

    it("is independent of the sampled decision", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.sampled).toBe(true);
      expect(data?.isTraceContentVisible).toBe(false);
    });
  });

  describe("workflow attribute helpers", () => {
    it("readPlanTraceId returns trace id when sampled", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession(),
      });
      expect(readPlanTraceId(plan)).toBe("0123456789abcdef0123456789abcdef");
    });

    it("readPlanTraceId returns undefined when unsampled", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => false } }),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "private" } },
        }),
      });
      expect(readPlanTraceId(plan)).toBeUndefined();
    });

    it("readPlanTraceId returns undefined for no plan", () => {
      expect(readPlanTraceId(undefined)).toBeUndefined();
    });

    it("readPlanChannelKind returns the frozen channel kind", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime(),
        session: makeSession({
          channel: { channelType: "web", kind: "web", metadata: { audience: "public" } },
        }),
      });
      expect(readPlanChannelKind(plan)).toBe("web");
    });

    it("readPlanTraceContext returns portable context when trace exists", () => {
      const plan = planSessionInstrumentation({
        runtime: makeRuntime({ otelSettings: { tracePolicy: () => true } }),
        session: makeSession(),
      });
      expect(readPlanTraceContext(plan)).toEqual({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 1,
      });
    });

    it("readPlanTraceContext returns undefined for inert plan", () => {
      const plan = planSessionInstrumentation({
        runtime: undefined,
        session: makeSession(),
      });
      expect(readPlanTraceContext(plan)).toBeUndefined();
    });
  });

  describe("frozen classification", () => {
    it("snapshots audience at planning time", () => {
      const metadata: { audience: ChannelAudience } = { audience: "public" };
      const channel: ChannelInstrumentationProjection = {
        channelType: "web",
        kind: "web",
        metadata,
      };
      const plan = planSessionInstrumentation({
        runtime: makeRuntime(),
        session: makeSession({ channel }),
      });
      const data = parseSessionInstrumentationPlan(plan);
      expect(data?.audience).toBe("public");

      // Mutate the channel metadata after planning — the plan must not change.
      metadata.audience = "private";
      const reParsed = parseSessionInstrumentationPlan(plan);
      expect(reParsed?.audience).toBe("public");
    });
  });
});
