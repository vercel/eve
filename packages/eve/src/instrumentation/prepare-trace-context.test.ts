import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { prepareTurnTraceContext } from "#instrumentation/prepare-trace-context.js";

describe("prepareTurnTraceContext", () => {
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
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        sessionStarted: false,
        turnId: "turn-1",
      }),
    );

    expect(context.get(SessionTraceSeedKey)).toEqual(seed);
  });
});
