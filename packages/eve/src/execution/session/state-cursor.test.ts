import { createTestSessionState } from "#internal/testing/session-state.js";
import { describe, expect, it, vi } from "vitest";

import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";

const stableToken = "eve:session:session-1:inbox";

describe("SessionStateCursor", () => {
  it("reconstructs a fresh session solely from the first turn's recorded delta", async () => {
    const initialSession = {
      compiledArtifactsSource: { kind: "development" },
      continuationToken: "",
      sessionId: "session-1",
    } satisfies import("#execution/create-session-step.js").CreateSessionInput;
    const finalState = state("");
    const recorded = await withSessionStateDelta({ serializedContext: {} }, async () => ({
      action: "park" as const,
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      serializedContext: { title: "first" },
      sessionState: finalState,
    }));
    const claimSessionHooks = vi.fn(async () => {});
    for (let replay = 0; replay < 2; replay++) {
      const cursor = new SessionStateCursor({
        inbox: { claimSessionHooks },
        initialSession,
        serializedContext: {},
        sessionWritable: new WritableStream<Uint8Array>(),
      });
      expect(cursor.optionalSessionState).toBeUndefined();
      const existingStep = vi.fn();
      const replayStep = vi.fn(async () => recorded);
      await cursor.advanceTurn(existingStep, replayStep);
      expect(existingStep).not.toHaveBeenCalled();
      expect(cursor.sessionState).toEqual(finalState);
      expect(cursor.serializedContext).toEqual({ title: "first" });
      expect(replayStep).toHaveBeenCalledWith(expect.objectContaining({ initialSession }));
    }
    expect(claimSessionHooks).toHaveBeenCalledTimes(2);
  });

  it("claims every new continuation address recorded during a step", async () => {
    const claimSessionHooks = vi.fn(async () => {});
    const inbox = {
      claimSessionHooks,
    };
    const initialState = state("channel:initial");
    const cursor = new SessionStateCursor({
      inbox,
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {
        [ContinuationHookTokensKey.name]: ["channel:initial"],
      },
      sessionState: initialState,
    });
    const nextState = state("channel:third");

    await cursor.advance((input) =>
      withSessionStateDelta(input, async () => ({
        serializedContext: {
          [ContinuationHookTokensKey.name]: ["channel:initial", "channel:second", "channel:third"],
        },
        sessionState: nextState,
      })),
    );

    expect(claimSessionHooks.mock.calls).toEqual([
      [[stableToken, "channel:initial", "channel:second", "channel:third"]],
    ]);
    expect(cursor.sessionState).toEqual(nextState);
  });

  it("claims the current continuation when no address history was recorded", async () => {
    const claimSessionHooks = vi.fn(async () => {});
    const cursor = new SessionStateCursor({
      inbox: {
        claimSessionHooks,
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });

    await cursor.advance((input) =>
      withSessionStateDelta(input, async () => ({ sessionState: state("channel:current") })),
    );

    expect(claimSessionHooks).toHaveBeenCalledWith([stableToken, "channel:current"]);
  });

  it("adopts exactly the state a step returned, including edits it made to its input in place", async () => {
    const initial = state("channel:initial");
    const cursor = new SessionStateCursor({
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { "eve.channel": { kind: "slack", state: { threadTs: "1.0" } } },
      sessionState: initial,
    });
    let returned: unknown;

    await cursor.advance(async ({ serializedContext, sessionState }) => {
      // The workflow hands the step a deserialized copy and the body a deserialized result.
      const input = structuredClone({ serializedContext, sessionState });
      const result = await withSessionStateDelta(input, async (values) => {
        const channel = values.serializedContext["eve.channel"] as {
          state: Record<string, unknown>;
        };
        channel.state.threadTs = "2.0";
        const session = values.sessionState.snapshot.session;
        const next = {
          serializedContext: values.serializedContext,
          sessionState: {
            ...values.sessionState,
            snapshot: {
              session: {
                ...session,
                history: [
                  ...session.history,
                  { content: "Bob's reply", role: "assistant" as const },
                ],
              },
            },
          },
        };
        returned = structuredClone(next);
        return next;
      });
      return structuredClone(result);
    });

    expect({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }).toStrictEqual(returned);
  });

  it("rejects a step's delta when another step changed the state while it ran", async () => {
    const cursor = new SessionStateCursor({
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state("channel:initial"),
    });
    const { promise: released, resolve: release } = Promise.withResolvers<void>();

    const slow = cursor.advance((input) =>
      withSessionStateDelta(input, async () => {
        await released;
        return { sessionState: state("channel:slow") };
      }),
    );
    await cursor.advance((input) =>
      withSessionStateDelta(input, async () => ({ sessionState: state("channel:fast") })),
    );
    release();

    await expect(slow).rejects.toThrow("Session state changed while a step ran");
    expect(cursor.sessionState.continuationToken).toBe("channel:fast");
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
