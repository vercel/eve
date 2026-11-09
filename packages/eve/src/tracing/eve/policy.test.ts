import { describe, expect, it } from "vitest";

import type {
  AgentSessionTraceState,
  AgentTraceStateStore,
  AgentTraceValues,
} from "#tracing/eve/agent-trace-state.js";
import { createEveCapturePolicy } from "#tracing/eve/policy.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

function storeWith(session: Partial<AgentSessionTraceState>): AgentTraceStateStore {
  const entries = new Map<string, unknown>([
    [
      "session:session-1",
      {
        context: { spanId: "b".repeat(16), traceFlags: 1, traceId: "a".repeat(32) },
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        ...session,
      },
    ],
  ]);
  return {
    delete: (kind, key) => void entries.delete(`${kind}:${key}`),
    entries: () => [],
    get: <K extends keyof AgentTraceValues>(kind: K, key: string) =>
      entries.get(`${kind}:${key}`) as AgentTraceValues[K] | undefined,
    set: (kind, key, value) => void entries.set(`${kind}:${key}`, value),
    update: () => {},
  };
}

function policyFor(
  channelAudience: ChannelAudience,
  provider = { recordInputs: true, recordOutputs: true },
) {
  return createEveCapturePolicy({
    environment: "production",
    ...provider,
    stateStore: storeWith({
      channelAudience,
      decision: { action: "record", recordInputs: true, recordOutputs: true },
    }),
  });
}

// #4850: a turn's activation names no audience; its content markers follow the session's.
describe("createEveCapturePolicy forOperation", () => {
  it.each([
    ["public", true],
    ["private", false],
    ["unknown", false],
  ] as const)(
    "bounds content by the session's %s audience when the operation names none",
    async (audience, recorded) => {
      await expect(policyFor(audience).forOperation({ sessionId: "session-1" })).resolves.toEqual({
        recordInputs: recorded,
        recordOutputs: recorded,
      });
    },
  );

  it("records no more content than the provider does", async () => {
    await expect(
      policyFor("public", { recordInputs: false, recordOutputs: true }).forOperation({
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ recordInputs: false, recordOutputs: true });
  });
});
