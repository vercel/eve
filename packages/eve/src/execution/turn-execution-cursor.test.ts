import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendTurnControlStep } from "#execution/turn-control-protocol.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";

vi.mock("./turn-control-protocol.js", () => ({
  sendTurnControlStep: vi.fn(),
}));

describe("TurnExecutionCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts transitions and reports each continuation token once", async () => {
    const parentWritable = new WritableStream<Uint8Array>();
    const cursor = new TurnExecutionCursor({
      controlToken: "turn-control",
      parentWritable,
      serializedContext: { revision: 1 },
      sessionState: createState("slack:C1:"),
    });
    const anchoredState = createState("slack:C1:T1");

    await cursor.adopt({ serializedContext: { revision: 2 }, sessionState: anchoredState });
    await cursor.adopt({ sessionState: anchoredState });

    expect(sendTurnControlStep).toHaveBeenCalledOnce();
    expect(sendTurnControlStep).toHaveBeenCalledWith({
      controlToken: "turn-control",
      payload: {
        continuationToken: "slack:C1:T1",
        kind: "turn-continuation-token",
      },
    });
    expect(cursor.createStepInput(undefined)).toEqual({
      input: undefined,
      parentWritable,
      serializedContext: { revision: 2 },
      sessionState: anchoredState,
    });
  });

  it("publishes a terminal transition without a redundant token update", async () => {
    const cursor = new TurnExecutionCursor({
      controlToken: "turn-control",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { revision: 1 },
      sessionState: createState("slack:C1:"),
    });
    const finalState = createState("slack:C1:T1");

    await cursor.finish(
      { serializedContext: { revision: 2 }, sessionState: finalState },
      { kind: "done", output: "ok" },
      [{ kind: "deliver", payloads: [{ message: "queued" }] }],
    );

    expect(sendTurnControlStep).toHaveBeenCalledOnce();
    expect(sendTurnControlStep).toHaveBeenCalledWith({
      controlToken: "turn-control",
      payload: {
        action: {
          kind: "done",
          output: "ok",
          serializedContext: { revision: 2 },
          sessionState: finalState,
        },
        bufferedDeliveries: [{ kind: "deliver", payloads: [{ message: "queued" }] }],
        kind: "turn-result",
      },
    });
  });
});

function createState(continuationToken: string): DurableSessionState {
  return {
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "session",
    version: 1,
  };
}
