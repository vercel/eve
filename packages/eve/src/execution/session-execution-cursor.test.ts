import { describe, expect, it, vi } from "vitest";

import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionExecutionCursor } from "#execution/session-execution-cursor.js";

describe("SessionExecutionCursor", () => {
  it("claims every new continuation address recorded during a step", async () => {
    const claimSessionHook = vi.fn(async () => {});
    const commandInbox = {
      claimSessionHook,
      sessionHookTokens: ["stable", "channel:initial"],
    };
    const initialState = state("channel:initial");
    const cursor = new SessionExecutionCursor({
      commandInbox,
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {
        [ContinuationHookTokensKey.name]: ["channel:initial"],
      },
      sessionState: initialState,
    });
    const nextState = state("channel:third");

    await cursor.adopt({
      serializedContext: {
        [ContinuationHookTokensKey.name]: ["channel:initial", "channel:second", "channel:third"],
      },
      sessionState: nextState,
    });

    expect(claimSessionHook.mock.calls).toEqual([["channel:second"], ["channel:third"]]);
    expect(cursor.sessionState).toBe(nextState);
  });

  it("claims the current continuation when no address history was recorded", async () => {
    const claimSessionHook = vi.fn(async () => {});
    const cursor = new SessionExecutionCursor({
      commandInbox: {
        claimSessionHook,
        sessionHookTokens: ["stable"],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });

    await cursor.adopt({ sessionState: state("channel:current") });

    expect(claimSessionHook).toHaveBeenCalledWith("channel:current");
  });
});

function state(continuationToken: string): DurableSessionState {
  return {
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    sessionId: "session-1",
    version: 1,
  };
}
