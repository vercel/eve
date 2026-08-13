import { describe, expect, it } from "vitest";

import {
  channelDirectedCallId,
  prepareChannelDirectedTurn,
} from "#execution/channel-directed-turn.js";
import {
  getPendingRuntimeActionBatch,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { settlePassThroughRuntimeActionTurn } from "#execution/pass-through-runtime-action-turn.js";

function session(sequence = 0) {
  return {
    agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 1000 },
    continuationToken: "slack:C1:T1",
    history: [],
    sessionId: "session-1",
    state: {
      "eve.harness.emission": { sessionStarted: true, sequence, stepIndex: 0, turnId: "" },
    },
  };
}

const command = {
  auth: null,
  kind: "route-remote" as const,
  message: "hello",
  remote: { description: "Remote", path: "/eve/v1/session", url: "https://example.com" },
  routeId: "https://example.com\n/eve/v1/session",
};

describe("prepareChannelDirectedTurn", () => {
  it("uses sequence-specific call identity and does not change model history", () => {
    const original = session(3);
    const prepared = prepareChannelDirectedTurn({ command, session: original });
    const batch = getPendingRuntimeActionBatch(prepared.state);

    expect(prepared.history).toEqual([]);
    expect(batch?.event).toEqual({ sequence: 3, stepIndex: 0, turnId: "turn_3" });
    expect(batch?.actions[0]).toMatchObject({
      callId: channelDirectedCallId(command.routeId, 3),
      input: { message: "hello" },
      kind: "remote-agent-call",
    });
  });

  it("applies the configured output schema to every routed action", () => {
    const withSchema = {
      ...command,
      remote: {
        ...command.remote,
        outputSchema: { properties: { answer: { type: "string" } }, type: "object" },
      },
    };
    const prepared = prepareChannelDirectedTurn({ command: withSchema, session: session(0) });
    expect(getPendingRuntimeActionBatch(prepared.state)?.actions[0]?.input).toMatchObject({
      outputSchema: withSchema.remote.outputSchema,
    });
  });

  it("rejects pass-through batches containing multiple actions", async () => {
    const original = session(0);
    const action = prepareChannelDirectedTurn({ command, session: original });
    const batch = getPendingRuntimeActionBatch(action.state)!;
    const invalid = setPendingRuntimeActionBatch({
      actions: [batch.actions[0]!, batch.actions[0]!],
      event: batch.event,
      responseMessages: [],
      session: action,
      settlement: "pass-through",
    });

    await expect(
      settlePassThroughRuntimeActionTurn({ emit: async () => {}, results: [], session: invalid }),
    ).rejects.toThrow("exactly one action");
  });

  it("settles an immediate dispatch failure without changing model history", async () => {
    const prepared = prepareChannelDirectedTurn({ command, session: session(1) });
    const callId = channelDirectedCallId(command.routeId, 1);
    const events: string[] = [];
    const settled = await settlePassThroughRuntimeActionTurn({
      emit: async (event) => {
        events.push(event.type);
      },
      results: [
        {
          callId,
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: { code: "REMOTE_AGENT_START_FAILED", message: "unavailable" },
          subagentName: command.routeId,
        },
      ],
      session: prepared,
    });

    expect(settled?.history).toEqual([]);
    expect(getPendingRuntimeActionBatch(settled?.state)).toBeUndefined();
    expect(events).toEqual(["action.result", "step.failed", "turn.failed", "session.waiting"]);
  });
});
