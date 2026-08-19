import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type {
  SessionCommandInbox,
  SessionInboxPayload,
  SessionInboxSource,
} from "#execution/session-command-inbox.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

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
function createMockInbox(reads: readonly ScriptedRead[], authorizationReady = false): MockInbox {
  const remaining = [...reads];
  const windowTransitions: boolean[] = [];

  return {
    windowTransitions,
    async claimAuthorization() {},
    async claimStable() {},
    consumeNext() {},
    hasReadyAuthorization() {
      return authorizationReady;
    },
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

function messageRead(message: string): ScriptedRead {
  return {
    result: { done: false, value: { kind: "send", payload: { message } } },
    source: "session",
  };
}

// Routing never runs in these tests: scripted reads stop at authorization
// instructions or exhaust before any deliver-kind turn payload.
const sessionState = { sessionId: "ses-parked-wait" } as DurableSessionState;

function observedReadySessionState(observed = true): DurableSessionState {
  const task: Record<string, unknown> = {
    createdByTurnId: "turn-parent",
    metadata: {
      agentId: "agent-1",
      kind: "subagent",
      mode: "local",
      name: "reviewer",
    },
    operationId: "operation-1",
    taskId: "task-1",
    taskInboxToken: "task-token",
    taskRunId: "task-run-1",
  };
  if (observed) task.lastPeekedReadyStatus = "completed";
  const taskState: Record<string, unknown> = {
    "eve.tasks": {
      tasks: [task],
    },
  };
  return {
    continuationToken: "parent-token",
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-parent" },
    hasProxyInputRequests: false,
    sessionId: "ses-parked-wait",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "parent-token",
        history: [],
        sessionId: "ses-parked-wait",
        state: taskState,
      },
      version: 1,
    },
    version: 1,
  };
}

function waitInput(inbox: SessionCommandInbox): Parameters<typeof nextTurnDelivery>[0] {
  return {
    awaitAuthorizationCallbacks: true,
    bufferedDeliveries: [],
    bufferedSessionControls: [],
    commandInbox: inbox,
    driverWritable: new WritableStream<Uint8Array>(),
    stateCursor: new SessionStateCursor({ serializedContext: {}, sessionState }),
  };
}

describe("nextTurnDelivery", () => {
  afterEach(() => {
    vi.mocked(routeDeliverToChildren).mockReset();
  });

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

  it("does not let buffered deliveries bypass a ready authorization callback", async () => {
    const inbox = createMockInbox([authorizationRead()], true);
    const bufferedDeliveries: DeliverHookPayload[] = [
      { kind: "deliver", payloads: [{ message: "later" }] },
    ];

    const next = await nextTurnDelivery({
      ...waitInput(inbox),
      bufferedDeliveries,
    });

    expect(next.kind).toBe("authorization");
    expect(bufferedDeliveries).toHaveLength(1);
  });

  it("buffers task deliveries until the authorization callback arrives", async () => {
    const inbox = createMockInbox([messageRead("deferred"), authorizationRead()]);
    const bufferedDeliveries: DeliverHookPayload[] = [];

    const next = await nextTurnDelivery({
      ...waitInput(inbox),
      bufferedDeliveries,
      deferDeliveries: true,
    });

    expect(next.kind).toBe("authorization");
    expect(bufferedDeliveries).toMatchObject([
      { kind: "deliver", payloads: [{ message: "deferred" }] },
    ]);
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

  it("carries retired proxy state through fully routed parked deliveries", async () => {
    const retiredState = { ...sessionState, hasProxyInputRequests: false };
    const inbox = createMockInbox([messageRead("child response"), messageRead("parent turn")]);
    vi.mocked(routeDeliverToChildren)
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: undefined,
        serializedContext: {},
        sessionState: retiredState,
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { kind: "deliver", payloads: [{ message: "parent turn" }] },
        serializedContext: {},
        sessionState: retiredState,
      });

    const next = await nextTurnDelivery({
      ...waitInput(inbox),
      awaitAuthorizationCallbacks: false,
    });

    expect(vi.mocked(routeDeliverToChildren).mock.calls[1]?.[0].sessionState).toBe(retiredState);
    expect(next).toMatchObject({
      delivery: { payloads: [{ message: "parent turn" }] },
      kind: "turn",
    });
  });
});

describe("nextTurnDelivery routing", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("keeps waiting instead of starting a parent turn for a fully routed task response", async () => {
    const sessionState = {
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: true,
      sessionId: "session",
      version: 1,
    } as const;
    const routedSessionState = { ...sessionState, hasProxyInputRequests: false };
    vi.mocked(routeDeliverToChildren)
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: undefined,
        serializedContext: {},
        sessionState,
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { kind: "deliver", payloads: [{ message: "ordinary" }] },
        serializedContext: {},
        sessionState: routedSessionState,
      });
    const commands = [
      { kind: "send" as const, payload: { inputResponses: [{ requestId: "task-request" }] } },
      { kind: "send" as const, payload: { message: "ordinary" } },
    ];
    const commandInbox: SessionCommandInbox = {
      claimAuthorization: vi.fn(),
      claimStable: vi.fn(),
      consumeNext: vi.fn(),
      hasReadyAuthorization: vi.fn(() => false),
      next: vi.fn(async () => ({ done: false as const, value: commands.shift()! })),
      nextWithSource: vi.fn(async () => ({
        result: { done: false as const, value: commands.shift()! },
        source: "session" as const,
      })),
      rekeyContinuation: vi.fn(),
      setAuthorizationWindow: vi.fn(),
    };

    const stateCursor = new SessionStateCursor({ serializedContext: {}, sessionState });
    const result = await nextTurnDelivery({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      driverWritable: new WritableStream<Uint8Array>(),
      stateCursor,
    });

    expect(result).toMatchObject({
      delivery: { payloads: [{ message: "ordinary" }] },
      kind: "turn",
    });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
    expect(stateCursor.sessionState).toBe(routedSessionState);
  });

  it.each(["task-1:update:child-turn:0:update-call", "task-1:ready:completed"])(
    "drops observed-ready task delivery %s before starting a turn",
    async (taskDeliveryId) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const state = observedReadySessionState();
      const taskDelivery = {
        kind: "deliver" as const,
        payloads: [{ message: "redundant task notification" }],
        taskDeliveryId,
      };
      const ordinaryDelivery = {
        kind: "deliver" as const,
        payloads: [{ message: "ordinary" }],
      };
      vi.mocked(routeDeliverToChildren).mockImplementation(async ({ delivery, sessionState }) => ({
        kind: "continue",
        remainder: delivery,
        serializedContext: {},
        sessionState,
      }));
      const commands = [taskDelivery, ordinaryDelivery];
      const commandInbox = createMockInbox(
        commands.map((value) => ({
          result: { done: false as const, value },
          source: "session" as const,
        })),
      );

      const result = await nextTurnDelivery({
        bufferedDeliveries: [],
        bufferedSessionControls: [],
        commandInbox,
        driverWritable: new WritableStream<Uint8Array>(),
        stateCursor: new SessionStateCursor({ serializedContext: {}, sessionState: state }),
      });

      expect(result).toMatchObject({ delivery: ordinaryDelivery, kind: "turn" });
      expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
      expect(debug).toHaveBeenCalledWith(
        "[eve:execution.parked-delivery-wait] dropping task delivery already observed through task_peek",
        { sessionId: "ses-parked-wait", taskDeliveryId },
      );
    },
  );

  it("keeps the first ready notification when task_peek has not observed it", async () => {
    const state = observedReadySessionState(false);
    const delivery = {
      kind: "deliver" as const,
      payloads: [{ message: "first task notification" }],
      taskDeliveryId: "task-1:ready:completed",
    };
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: delivery,
      serializedContext: {},
      sessionState: state,
    });

    const result = await nextTurnDelivery({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox: createMockInbox([
        { result: { done: false, value: delivery }, source: "session" },
      ]),
      driverWritable: new WritableStream<Uint8Array>(),
      stateCursor: new SessionStateCursor({ serializedContext: {}, sessionState: state }),
    });

    expect(result).toMatchObject({ delivery, kind: "turn" });
  });
});
