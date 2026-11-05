import { createTestSessionState } from "#internal/testing/session-state.js";
import { describe, expect, it, vi } from "vitest";

import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { OpenTurn } from "#execution/session/open-turn.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";

const stableToken = "eve:session:session-1:inbox";

describe("SessionStateCursor", () => {
  it("claims every new continuation address recorded during a step", async () => {
    const claimSessionHooks = vi.fn(async () => {});
    const inbox = {
      claimSessionHooks,
    };
    const initialState = state("channel:initial");
    const cursor = new SessionStateCursor({
      history: [],
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
      history: [],
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

  it("adopts exactly the values a step returned, including edits it made to its input in place", async () => {
    const cursor = new SessionStateCursor({
      history: [{ content: "Alice asks for the status.", kind: "user", role: "user" }],
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { "eve.channel": { kind: "slack", state: { threadTs: "1.0" } } },
      sessionState: state("channel:initial"),
    });
    let returned: unknown;

    await cursor.advanceWithHistory(async ({ history, serializedContext, sessionState }) => {
      // The workflow hands the step a deserialized copy and the body a deserialized result.
      const input = structuredClone({ history, serializedContext, sessionState });
      const result = await withSessionStateDelta(input, async (values) => {
        const channel = values.serializedContext["eve.channel"] as {
          state: Record<string, unknown>;
        };
        channel.state.threadTs = "2.0";
        const next = {
          history: [...values.history, { content: "Bob's reply", role: "assistant" as const }],
          serializedContext: values.serializedContext,
          sessionState: { ...values.sessionState, continuationToken: "channel:next" },
        };
        returned = structuredClone(next);
        return next;
      });
      return structuredClone(result);
    });

    expect({
      history: cursor.history,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }).toStrictEqual(returned);
  });

  it("rejects a history change from a step that was not given the history", async () => {
    const history = [
      { content: "Alice asks for the status.", kind: "user" as const, role: "user" as const },
    ];
    const cursor = new SessionStateCursor({
      history,
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state("channel:initial"),
    });

    await expect(
      cursor.advance((input) => withSessionStateDelta(input, async () => ({ history: [] }))),
    ).rejects.toThrow("not given the history cannot change it");
    expect(cursor.history).toBe(history);
  });

  it("rejects a step's delta when another step changed the state while it ran", async () => {
    const cursor = new SessionStateCursor({
      history: [],
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

  it.each([
    { meanwhile: "nothing", adopted: true },
    { meanwhile: "a completed step", adopted: false },
    { meanwhile: "a running step", adopted: false },
    { meanwhile: "losing interest", adopted: false },
    { meanwhile: "a new session address in its delta", adopted: false },
  ])(
    "adopts a step run beside the others only after $meanwhile",
    async ({ meanwhile, adopted }) => {
      const claimSessionHooks = vi.fn(async () => {});
      const cursor = new SessionStateCursor({
        history: [],
        inbox: { claimSessionHooks },
        sessionWritable: new WritableStream<Uint8Array>(),
        serializedContext: {},
        sessionState: state("channel:initial"),
      });
      const beside = Promise.withResolvers<void>();
      const step = Promise.withResolvers<void>();
      let wanted = true;
      const besideState =
        meanwhile === "a new session address in its delta"
          ? state("channel:beside")
          : { ...state("channel:initial"), hasProxyInputRequests: true };
      const result = cursor.advanceBeside(
        (input) =>
          withSessionStateDelta(input, async () => {
            await beside.promise;
            return { sessionState: besideState };
          }),
        () => wanted,
      );
      const ownStep = () =>
        cursor.advance((input) =>
          withSessionStateDelta(input, async () => {
            await step.promise;
            return { sessionState: state("channel:step") };
          }),
        );

      let running: Promise<unknown> | undefined;
      if (meanwhile === "a completed step") {
        step.resolve();
        await ownStep();
      }
      if (meanwhile === "a running step") running = ownStep();
      if (meanwhile === "losing interest") wanted = false;
      beside.resolve();

      await expect(result).resolves.toBe(adopted);
      step.resolve();
      await running;
      expect(cursor.sessionState.hasProxyInputRequests).toBe(adopted);
      // Only the owner's own steps claim addresses.
      if (meanwhile === "nothing") expect(claimSessionHooks).not.toHaveBeenCalled();
    },
  );

  it("records where the open turn goes on before a step runs and once it is adopted", async () => {
    const records: unknown[] = [];
    const cursor = new SessionStateCursor({
      history: [],
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      open: { at: "step" },
      record: async ({ open }) => {
        records.push({ open, sessionState: cursor.sessionState.hasProxyInputRequests });
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });
    const paused: OpenTurn = { at: "pause", pause: { on: "tasks", taskIds: ["task-1"] } };

    await cursor.advance(
      (input) =>
        withSessionStateDelta(input, async () => {
          // The record before the step is written once it was saved, with the values it reads.
          expect(records).toEqual([{ open: { at: "step" }, sessionState: false }]);
          return { sessionState: { ...state(""), hasProxyInputRequests: true } };
        }),
      { after: () => paused, before: { at: "step" } },
    );
    // A step that declares no change keeps the turn where it was, and still records.
    await cursor.advance((input) => withSessionStateDelta(input, async () => ({})));

    expect(records).toEqual([
      { open: { at: "step" }, sessionState: false },
      { open: paused, sessionState: true },
      { open: paused, sessionState: true },
    ]);
    expect(cursor.open).toEqual(paused);
  });

  it("settles once no step runs, after the last one is recorded", async () => {
    let recorded = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cursor = new SessionStateCursor({
      history: [],
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      record: async () => {
        recorded += 1;
      },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });
    await cursor.settledStep();
    const step = cursor.advance(async (input) => {
      await gate;
      return await withSessionStateDelta(input, async () => ({}));
    });
    let settled = false;
    const waiting = cursor.settledStep().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await step;
    await waiting;
    expect(recorded).toBe(1);
  });

  it("marks only the first step a rerun of the one a stopped process left", async () => {
    const reruns: unknown[] = [];
    const cursor = new SessionStateCursor({
      history: [],
      inbox: { claimSessionHooks: vi.fn(async () => {}) },
      rerunFirst: true,
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(""),
    });
    for (let index = 0; index < 2; index++)
      await cursor.advance(async ({ rerun }) => {
        reruns.push(rerun);
        return { stateDelta: {} };
      });
    expect(reruns).toEqual([true, undefined]);
  });
});

function state(continuationToken: string): DurableSessionState {
  return createTestSessionState({
    continuationToken,
    hasProxyInputRequests: false,
    sessionId: "session-1",
  });
}
