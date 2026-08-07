import { beforeEach, describe, expect, it, vi } from "vitest";

import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

describe("nextTurnDelivery routing", () => {
  beforeEach(() => vi.clearAllMocks());
  it("keeps waiting instead of starting a parent turn for a fully routed task response", async () => {
    const sessionState = {
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: true,
      sessionId: "session",
      version: 1,
    } as const;
    vi.mocked(routeDeliverToChildren)
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: undefined,
        serializedContext: {},
        sessionState,
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { message: "ordinary" },
        serializedContext: {},
        sessionState,
      });
    const commands = [
      { kind: "send" as const, payload: { inputResponses: [{ requestId: "task-request" }] } },
      { kind: "send" as const, payload: { message: "ordinary" } },
    ];
    const commandInbox: SessionCommandInbox = {
      claimStable: vi.fn(),
      consumeNext: vi.fn(),
      next: vi.fn(async () => ({ done: false as const, value: commands.shift()! })),
      rekeyContinuation: vi.fn(),
    };

    const result = await nextTurnDelivery({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      driverWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState,
    });

    expect(result).toMatchObject({ kind: "turn", remainder: { message: "ordinary" } });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
  });
});
