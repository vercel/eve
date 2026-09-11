import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { prepareTurnTraceContext } from "#instrumentation/prepare-trace-context.js";

describe("prepareTurnTraceContext", () => {
  it("reuses session parent metadata without copying the seed onto a turn event", async () => {
    const seed = { spanId: "2".repeat(16), traceFlags: 1, traceId: "1".repeat(32) };
    const parentLineage = {
      callId: "call-1",
      sessionId: "parent-session",
      turnId: "parent-turn",
    };
    const prepareSessionTrace = vi.fn(async (_event: unknown) => seed);
    const prepareTurnTrace = vi.fn(async (_event: unknown) => seed);

    await prepareTurnTraceContext({
      instrumentation: { prepareSessionTrace, prepareTurnTrace },
      session: {
        agentName: "child",
        channelAudience: "private",
        parentLineage,
        parentTraceContext: seed,
        rootSessionId: "root-session",
        sessionId: "child-session",
        traceSeed: seed,
      },
      sequence: 0,
      sessionStarted: false,
      turnId: "turn-1",
    });

    const identity = {
      agentName: "child",
      parentLineage,
      parentTraceContext: seed,
      rootSessionId: "root-session",
      sessionId: "child-session",
    };
    expect(prepareSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({ ...identity, traceSeed: seed, type: "session.started" }),
    );
    expect(prepareTurnTrace).toHaveBeenCalledWith(
      expect.objectContaining({ ...identity, type: "turn.started", turnId: "turn-1" }),
    );
    expect(prepareTurnTrace.mock.calls[0]?.[0]).not.toHaveProperty("traceSeed");
    expect(prepareTurnTrace.mock.calls[0]?.[0]).not.toHaveProperty("channelAudience");
  });

  it("backfills a persisted trace decision for pre-seed workflow contexts", async () => {
    const context = new ContextContainer();
    const seed = {
      decision: { action: "record", recordInputs: false, recordOutputs: true } as const,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };

    await contextStorage.run(context, () =>
      prepareTurnTraceContext({
        instrumentation: {
          prepareSessionTrace: async () => seed,
        },
        session: { rootSessionId: "session-1", sessionId: "session-1" },
        sequence: 0,
        sessionStarted: false,
        turnId: "turn-1",
      }),
    );

    expect(context.get(SessionTraceSeedKey)).toEqual(seed);
  });
});
