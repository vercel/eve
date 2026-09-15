import { createTestSessionState } from "#internal/testing/session-state.js";
import { describe, expect, it, vi } from "vitest";

import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";

const stableToken = "eve:session:session-1:inbox";

describe("SessionStateCursor", () => {
  it("claims every new continuation address recorded during a step", async () => {
    const claimSessionHooks = vi.fn(async () => {});
    const inbox = {
      claimSessionHooks,
    };
    const initialState = state("channel:initial");
    const cursor = new SessionStateCursor({
      inbox,
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {
        [ContinuationHookTokensKey.name]: ["channel:initial"],
      },
      sessionState: initialState,
    });
    const nextState = state("channel:third");

    await cursor.apply({
      serializedContext: {
        [ContinuationHookTokensKey.name]: ["channel:initial", "channel:second", "channel:third"],
      },
      sessionState: nextState,
    });

    expect(claimSessionHooks.mock.calls).toEqual([
      [[stableToken, "channel:initial", "channel:second", "channel:third"]],
    ]);
    expect(cursor.sessionState).toBe(nextState);
  });

  it("claims the current continuation when no address history was recorded", async () => {
    const claimSessionHooks = vi.fn(async () => {});
    const cursor = new SessionStateCursor({
      inbox: {
        claimSessionHooks,
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });

    await cursor.apply({ sessionState: state("channel:current") });

    expect(claimSessionHooks).toHaveBeenCalledWith([stableToken, "channel:current"]);
  });
});

function state(continuationToken: string): DurableSessionState {
  return createTestSessionState({
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    sessionId: "session-1",
    version: 1,
  });
}
