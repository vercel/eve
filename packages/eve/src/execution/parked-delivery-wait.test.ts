import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import type {
  SessionCommandInbox,
  SessionInboxPayload,
  SessionInboxSource,
} from "#execution/session-command-inbox.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

interface ScriptedRead {
  readonly result: IteratorResult<SessionInboxPayload>;
  readonly source: SessionInboxSource;
}

interface MockInbox extends SessionCommandInbox {
  readonly windowTransitions: boolean[];
}

/**
 * Scripted inbox: serves reads in order and records every authorization
 * window transition so tests can assert the window spans the whole wait.
 */
function createMockInbox(reads: readonly ScriptedRead[]): MockInbox {
  const remaining = [...reads];
  const windowTransitions: boolean[] = [];

  return {
    windowTransitions,
    async claimAuthorization() {},
    async claimStable() {},
    consumeNext() {},
    async next() {
      const read = remaining.shift();
      if (read === undefined) throw new Error("Mock inbox exhausted.");
      return read.result;
    },
    async nextWithSource() {
      const read = remaining.shift();
      if (read === undefined) throw new Error("Mock inbox exhausted.");
      return read;
    },
    async rekeyContinuation() {},
    setAuthorizationWindow(open: boolean) {
      windowTransitions.push(open);
    },
  };
}

function authorizationRead(): ScriptedRead {
  return {
    result: {
      done: false,
      value: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { method: "GET", params: { code: "abc" } },
              connectionName: "weather",
            },
          },
        ],
      } satisfies DeliverHookPayload,
    },
    source: "authorization",
  };
}

function cancelRead(): ScriptedRead {
  return {
    result: { done: false, value: { kind: "cancel" } },
    source: "session",
  };
}

// Routing never runs in these tests: scripted reads stop at authorization
// instructions or exhaust before any deliver-kind turn payload.
const sessionState = { sessionId: "ses-parked-wait" } as DurableSessionState;

function waitInput(inbox: SessionCommandInbox): Parameters<typeof nextTurnDelivery>[0] {
  return {
    awaitAuthorizationCallbacks: true,
    bufferedDeliveries: [],
    bufferedSessionControls: [],
    commandInbox: inbox,
    driverWritable: new WritableStream<Uint8Array>(),
    sessionState,
  };
}

describe("nextTurnDelivery", () => {
  it("surfaces an authorization callback as its own instruction", async () => {
    const inbox = createMockInbox([authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization");
    if (next.kind !== "authorization") throw new Error("unreachable");
    expect(next.closed).toBe(false);
    expect(next.payloads).toHaveLength(1);
    expect(inbox.windowTransitions).toEqual([true, false]);
  });

  it("keeps the authorization window open across a consumed no-op cancel", async () => {
    // A cancel with no active turn is consumed without producing a parent
    // turn; the wait continues and the callback must still surface within
    // the same window instead of stashing until unrelated activity.
    const inbox = createMockInbox([cancelRead(), authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization");
    expect(inbox.windowTransitions).toEqual([true, false]);
  });

  it("reports a closed authorization hook", async () => {
    const inbox = createMockInbox([
      { result: { done: true, value: undefined }, source: "authorization" },
    ]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next).toMatchObject({ closed: true, kind: "authorization", payloads: [] });
  });

  it("never opens the window without an open challenge", async () => {
    const inbox = createMockInbox([cancelRead(), cancelRead()]);

    await expect(
      nextTurnDelivery({ ...waitInput(inbox), awaitAuthorizationCallbacks: false }),
    ).rejects.toThrow("Mock inbox exhausted.");
    expect(inbox.windowTransitions).toEqual([]);
  });
});
