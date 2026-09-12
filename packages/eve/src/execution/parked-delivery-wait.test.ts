import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import { SessionBacklog } from "#execution/session-backlog.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cacheTerminalTaskView } from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));
vi.mock("./cancel-indexed-session-tasks-step.js", () => ({
  cancelAllIndexedSessionTasksStep: vi.fn(),
}));

import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";

beforeEach(() => {
  vi.mocked(routeDeliverToChildren).mockReset();
  vi.mocked(cancelAllIndexedSessionTasksStep).mockReset();
});

interface ScriptedRead {
  readonly result: IteratorResult<SessionInboxPayload>;
}

interface MockInbox extends SessionInbox {
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
    async claimSessionHook() {},
    consumeNext() {},
    drain() {
      return remaining.splice(0).map((read) => read.result.value);
    },
    hasReadyAuthorization() {
      return authorizationReady;
    },
    hasPending() {
      return remaining.length > 0;
    },
    async next() {
      const read = remaining.shift();
      if (read === undefined) throw new Error("Mock inbox exhausted.");
      return read.result;
    },
    sessionHookTokens: ["stable"],
    restore() {},
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
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId: "attempt-1",
              callback: { method: "GET", params: { code: "abc" } },
              connectionName: "weather",
            },
          },
        ],
      } satisfies SessionInboxPayload,
    },
  };
}

function cancelRead(command: Record<string, unknown> = {}): ScriptedRead {
  return {
    result: { done: false, value: { kind: "cancel", ...command } },
  };
}

function messageRead(message: string): ScriptedRead {
  return {
    result: { done: false, value: { kind: "send", payload: { message } } },
  };
}

const sessionState = createTestSessionState({ sessionId: "ses-parked-wait" });

type WaitInput = {
  -readonly [K in keyof Parameters<typeof nextTurnDelivery>[0]]: Parameters<
    typeof nextTurnDelivery
  >[0][K];
};

function waitInput(inbox: SessionInbox): WaitInput {
  return {
    awaitAuthorizationCallbacks: true,
    backlog: new SessionBacklog(),
    commandInbox: inbox,
    cursor: createCursor(inbox),
  };
}

function createCursor(inbox: SessionInbox, state = sessionState): SessionStateCursor {
  return new SessionStateCursor({
    commandInbox: inbox,
    parentWritable: new WritableStream<Uint8Array>(),
    serializedContext: {},
    sessionState: state,
  });
}

function backlogOf(...deliveries: DeliverHookPayload[]): SessionBacklog {
  const backlog = new SessionBacklog();
  backlog.deliveries.push(...deliveries);
  return backlog;
}

describe("nextTurnDelivery", () => {
  it("batches adjacent queued deliveries with equivalent auth", async () => {
    const auth: SessionAuthContext = {
      attributes: { scopes: ["read", "write"], team: "support" },
      authenticator: "slack",
      issuer: "workspace",
      principalId: "bob",
      principalType: "user",
      subject: "bob-subject",
    };
    const first = authenticatedDelivery("first", auth);
    const second = authenticatedDelivery("second", {
      ...auth,
      attributes: { team: "support", scopes: ["read", "write"] },
    });
    const input = batchingInputFor([first, second]);

    const next = await nextTurnDelivery(input);

    expect(next).toMatchObject({
      kind: "turn",
      delivery: {
        auth,
        payloads: [...first.payloads, ...second.payloads],
        deliveryMetadata: [
          first.deliveryMetadata![0],
          { ...second.deliveryMetadata![0], payloadIndex: 1 },
        ],
      },
    });
    expect(input.backlog.deliveries).toEqual([]);
  });

  it("keeps different principals in FIFO turns without regrouping later messages", async () => {
    const alice = slackAuth("alice");
    const bob = slackAuth("bob");
    const deliveries = [
      authenticatedDelivery("alice-1", alice),
      authenticatedDelivery("alice-2", alice),
      authenticatedDelivery("bob", bob),
      authenticatedDelivery("alice-3", alice),
    ];
    const input = batchingInputFor(deliveries);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: { payloads: [{ message: "alice-1" }, { message: "alice-2" }] },
      kind: "turn",
    });
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: { payloads: [{ message: "bob" }] },
      kind: "turn",
    });
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: { payloads: [{ message: "alice-3" }] },
      kind: "turn",
    });
    expect(input.backlog.deliveries).toEqual([]);
  });

  it.each([
    { authenticator: "other" },
    { issuer: "other" },
    { principalType: "service" },
    { subject: "other" },
    { attributes: { scopes: ["write"] } },
  ])("does not batch when auth context changes: %j", async (change) => {
    const auth = slackAuth("alice");
    const first = authenticatedDelivery("first", auth);
    const second = authenticatedDelivery("second", { ...auth, ...change });
    const input = batchingInputFor([first, second]);

    await expect(nextTurnDelivery(input)).resolves.toEqual({ delivery: first, kind: "turn" });
    expect(input.backlog.deliveries).toEqual([second]);
  });

  it.each([null, undefined])("does not batch deliveries with auth %j", async (auth) => {
    const first: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "first" }] };
    const second: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "second" }] };
    const input = batchingInputFor([first, second]);

    await expect(nextTurnDelivery(input)).resolves.toEqual({ delivery: first, kind: "turn" });
    expect(input.backlog.deliveries).toEqual([second]);
  });

  it("surfaces an authorization callback as its own instruction", async () => {
    const inbox = createMockInbox([authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization");
    if (next.kind !== "authorization") throw new Error("unreachable");
    expect(next.payloads).toHaveLength(1);
    expect(inbox.windowTransitions).toEqual([true, false]);
  });

  it("cancels indexed tasks and keeps waiting for ordinary parked activity", async () => {
    const inbox = createMockInbox([cancelRead({ tasks: true }), authorizationRead()]);
    const input = waitInput(inbox);

    const next = await nextTurnDelivery(input);

    expect(next.kind).toBe("authorization");
    expect(cancelAllIndexedSessionTasksStep).toHaveBeenCalledWith({
      serializedContext: input.cursor.serializedContext,
      sessionState: input.cursor.sessionState,
    });
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
    const backlog = backlogOf({ kind: "deliver", payloads: [{ message: "later" }] });

    const next = await nextTurnDelivery({ ...waitInput(inbox), backlog });

    expect(next.kind).toBe("authorization");
    expect(backlog.deliveries).toHaveLength(1);
  });

  it("buffers task deliveries until the authorization callback arrives", async () => {
    const inbox = createMockInbox([messageRead("deferred"), authorizationRead()]);
    const backlog = new SessionBacklog();

    const next = await nextTurnDelivery({ ...waitInput(inbox), backlog, deferDeliveries: true });

    expect(next.kind).toBe("authorization");
    expect(backlog.deliveries).toMatchObject([
      { kind: "deliver", payloads: [{ message: "deferred" }] },
    ]);
  });

  it("reports session closure while waiting for authorization", async () => {
    const inbox = createMockInbox([{ result: { done: true, value: undefined } }]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next).toMatchObject({ kind: "closed" });
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

function slackAuth(principalId: string): SessionAuthContext {
  return {
    attributes: { scopes: ["read"], team: "support" },
    authenticator: "slack",
    issuer: "workspace",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

function authenticatedDelivery(message: string, auth: SessionAuthContext): DeliverHookPayload {
  return {
    auth,
    deliveryMetadata: [
      {
        channelKind: "slack",
        channelName: "slack",
        deliveryId: message,
        payloadIndex: 0,
      },
    ],
    kind: "deliver",
    payloads: [{ message }],
    turnPolicy: "queue",
  };
}

function batchingInputFor(bufferedDeliveries: DeliverHookPayload[]) {
  const input = waitInput(createMockInbox([]));
  vi.mocked(routeDeliverToChildren).mockImplementation(
    async ({ delivery, serializedContext, sessionState }) => ({
      kind: "continue",
      remainder: delivery,
      serializedContext,
      sessionState,
    }),
  );
  return { ...input, backlog: backlogOf(...bufferedDeliveries) };
}

describe("nextTurnDelivery routing", () => {
  it("keeps waiting instead of starting a parent turn for a fully routed task response", async () => {
    const sessionState = createTestSessionState({
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: true,
      sessionId: "session",
      version: 1,
    });
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
    const commandInbox: SessionInbox = {
      claimSessionHook: vi.fn(),
      consumeNext: vi.fn(),
      drain: vi.fn(() => commands.splice(0)),
      hasReadyAuthorization: vi.fn(() => false),
      hasPending: vi.fn(() => commands.length > 0),
      next: vi.fn(async () => ({ done: false as const, value: commands.shift()! })),
      restore: vi.fn(),
      sessionHookTokens: ["stable"],
      setAuthorizationWindow: vi.fn(),
    };

    const cursor = createCursor(commandInbox, sessionState);
    const result = await nextTurnDelivery({
      backlog: new SessionBacklog(),
      commandInbox,
      cursor,
    });

    expect(result).toMatchObject({
      delivery: { payloads: [{ message: "ordinary" }] },
      kind: "turn",
    });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
    expect(cursor.sessionState).toBe(routedSessionState);
  });
});

function completion(taskId: string): DeliverHookPayload {
  return {
    kind: "deliver",
    taskDeliveryId: `${taskId}:ready:completed`,
    payloads: [
      {
        message: taskId,
        task: {
          views: [
            {
              taskId,
              status: "completed",
              metadata: { kind: "subagent", name: "worker" },
              lastOutput: { type: "result", data: taskId },
            },
          ],
        },
      },
    ],
    deliveryMetadata: [
      {
        payloadIndex: 0,
        deliveryId: taskId,
        channelKind: "eve",
        channelName: "eve",
        acceptedDeploymentId: "deployment",
      },
    ],
  };
}

function batchingInput(count = 100, crossTurn = false) {
  const input = waitInput(createMockInbox([]));
  input.cursor.adoptState({
    sessionState: {
      ...sessionState,
      snapshot: {
        session: {
          sessionId: "session",
          continuationToken: "token",
          history: [],
          agent: { system: "" },
          state: {
            "eve.tasks": {
              version: 2,
              tasks: Array.from({ length: count }, (_, index) => ({
                taskId: `task_${index}`,
                cohortId: "task_0",
                taskRunId: `run-${index}`,
                taskInboxToken: `inbox-${index}`,
                createdByTurnId: crossTurn ? `turn-${index + 1}` : "turn-1",
                metadata: { kind: "subagent", name: "worker" },
              })).concat([
                {
                  taskId: "other-cohort",
                  cohortId: "other-cohort",
                  taskRunId: "other-run",
                  taskInboxToken: "other-inbox",
                  createdByTurnId: "turn-2",
                  metadata: { kind: "subagent", name: "worker" },
                },
              ]),
            },
          },
        },
      },
    },
  });
  vi.mocked(routeDeliverToChildren).mockImplementation(
    async ({ delivery, sessionState, serializedContext }) => ({
      kind: "continue",
      remainder: delivery,
      sessionState,
      serializedContext,
    }),
  );
  return { ...input };
}

describe("buffered task completion batching", () => {
  beforeEach(() => vi.mocked(routeDeliverToChildren).mockReset());
  afterEach(() => vi.mocked(routeDeliverToChildren).mockReset());

  it("delivers 100 buffered sibling results and their metadata in one parent turn", async () => {
    const input = batchingInput();
    const deliveries = Array.from({ length: 100 }, (_, index) => completion(`task_${index}`));
    const backlog = backlogOf(...deliveries);
    const next = await nextTurnDelivery({ ...input, backlog });

    expect(next).toMatchObject({
      kind: "turn",
      delivery: {
        taskDeliveryId: "task_0:ready:completed",
        payloads: deliveries.flatMap((delivery) => delivery.payloads),
        deliveryMetadata: deliveries.map((delivery, payloadIndex) => ({
          ...delivery.deliveryMetadata![0],
          payloadIndex,
        })),
      },
    });
    expect(backlog.deliveries).toEqual([]);
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed", { ...completion("task_2"), taskDeliveryId: "task_2:ready:failed" }],
    ["cancelled", { ...completion("task_2"), taskDeliveryId: "task_2:ready:cancelled" }],
    ["input request", { ...completion("task_2"), taskDeliveryId: "task_2:input:request-1" }],
    ["update", { ...completion("task_2"), taskDeliveryId: "task_2:update:1" }],
    ["other cohort", completion("other-cohort")],
    ["unknown task", completion("unknown-task")],
    ["user message", { kind: "deliver", payloads: [{ message: "user direction" }] }],
    [
      "caller",
      {
        ...completion("task_2"),
        caller: {
          callId: "call",
          subagentName: "worker",
          replyTo: { kind: "hook", token: "reply" },
          taskId: "task_2",
        },
      },
    ],
  ] satisfies readonly (readonly [string, DeliverHookPayload])[])(
    "services a %s while retaining incomplete cohorts",
    async (_name, boundary) => {
      const input = batchingInput();
      const first = completion("task_0");
      const second = completion("task_1");
      const later = completion("task_3");
      const backlog = backlogOf(first, second, boundary, later);
      const next = await nextTurnDelivery({ ...input, backlog });
      expect(next).toEqual({ kind: "turn", delivery: boundary });
      expect(backlog.deliveries).toEqual([first, second, later]);
    },
  );

  it.each([false, true])(
    "keeps the cohort across a user turn (cross-turn launches: %s)",
    async (crossTurn) => {
      const input = batchingInput(3, crossTurn);
      const first = completion("task_0");
      const second = completion("task_1");
      const last = completion("task_2");
      input.backlog.deliveries.push(first);
      input.commandInbox = createMockInbox([
        { result: { done: false, value: second } },
        messageRead("user question"),
        { result: { done: false, value: last } },
      ]);

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: { payloads: [{ message: "user question" }] },
      });
      expect(input.backlog.deliveries).toEqual([first, second]);
      expect(routeDeliverToChildren).toHaveBeenCalledTimes(1);

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: { payloads: [...first.payloads, ...second.payloads, ...last.payloads] },
      });
      expect(input.backlog.deliveries).toEqual([]);
      expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
    },
  );

  it("batches a whole cohort when every completion arrives after the active turn", async () => {
    const input = batchingInput(3);
    const deliveries = [completion("task_0"), completion("task_1"), completion("task_2")];
    input.commandInbox = createMockInbox(
      deliveries.map((value) => ({ result: { done: false, value }, source: "session" })),
    );
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: deliveries.flatMap((delivery) => delivery.payloads) },
    });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(1);
  });

  it("routes intervening child settlement before releasing the completion cohort", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    const last = completion("task_1");
    const settlement: DeliverHookPayload = {
      kind: "deliver",
      payloads: [
        {
          task: {
            agentRequests: [
              {
                taskId: "task_1",
                replyTo: "child-reply",
                request: {
                  kind: "agent-settled",
                  result: {
                    callId: "child-call",
                    kind: "subagent-result",
                    origin: "child",
                    subagentName: "worker",
                    output: "done",
                    outcome: {
                      kind: "terminal",
                      result: { kind: "succeeded", output: "done" },
                      usageDelta: {
                        inputTokens: 211,
                        outputTokens: 37,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    };
    input.backlog.deliveries.push(first, settlement, last);
    vi.mocked(routeDeliverToChildren).mockImplementation(
      async ({ delivery, sessionState, serializedContext }) => ({
        kind: "continue",
        remainder: delivery.payloads.some((payload) => payload.task?.agentRequests !== undefined)
          ? undefined
          : delivery,
        sessionState,
        serializedContext,
      }),
    );

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...first.payloads, ...last.payloads] },
    });
    expect(vi.mocked(routeDeliverToChildren).mock.calls.map(([call]) => call.delivery)).toEqual([
      settlement,
      expect.objectContaining({ payloads: [...first.payloads, ...last.payloads] }),
    ]);
    expect(input.backlog.deliveries).toEqual([]);
  });

  it("combines siblings across buffered deliveries from another cohort", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    const last = completion("task_1");
    const other = completion("other-cohort");
    input.backlog.deliveries.push(first, other, last);
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...first.payloads, ...last.payloads] },
    });
    expect(input.backlog.deliveries).toEqual([other]);
    await expect(nextTurnDelivery(input)).resolves.toEqual({ kind: "turn", delivery: other });
  });

  it.each(["clear", "compact", "reset", "session-timeout"] as const)(
    "services %s without releasing an incomplete cohort",
    async (kind) => {
      const input = batchingInput(2);
      const first = completion("task_0");
      input.backlog.deliveries.push(first);
      input.commandInbox = createMockInbox([{ result: { done: false, value: { kind } } }]);
      await expect(nextTurnDelivery(input)).resolves.toEqual({
        kind: kind === "session-timeout" ? "expired" : kind,
      });
      expect(input.backlog.deliveries).toEqual([first]);
      expect(routeDeliverToChildren).not.toHaveBeenCalled();
    },
  );

  it("does not wait for a cancelled sibling whose notifications are discarded", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    input.backlog.deliveries.push(first);
    input.commandInbox = createMockInbox([cancelRead({ taskId: "task_1" })]);
    await expect(nextTurnDelivery(input)).resolves.toEqual({ kind: "turn", delivery: first });
  });

  it("ignores duplicate notifications while waiting for the last sibling", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    const last = completion("task_1");
    input.commandInbox = createMockInbox(
      [first, first, last].map((value) => ({
        result: { done: false, value },
        source: "session",
      })),
    );
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...first.payloads, ...last.payloads] },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "delivers %s immediately, then releases successful siblings from the settled cohort",
    async (status) => {
      const input = batchingInput(2);
      const first = completion("task_0");
      const view: TaskView = {
        taskId: "task_1",
        metadata: { kind: "subagent", name: "worker" },
        ...(status === "failed"
          ? { status, lastOutput: { type: "error", data: "failed" } }
          : { status }),
      };
      const terminal: DeliverHookPayload = {
        kind: "deliver",
        taskDeliveryId: `task_1:ready:${status}`,
        payloads: [{ message: status, task: { views: [view] } }],
      };
      input.backlog.deliveries.push(first, terminal);
      vi.mocked(routeDeliverToChildren).mockImplementation(
        async ({ delivery, sessionState, serializedContext }) => {
          const snapshot = sessionState.snapshot!;
          return {
            kind: "continue",
            remainder: delivery,
            serializedContext,
            sessionState: {
              ...sessionState,
              snapshot: {
                ...snapshot,
                session: {
                  ...snapshot.session,
                  state: cacheTerminalTaskView(snapshot.session.state, view),
                },
              },
            },
          };
        },
      );
      await expect(nextTurnDelivery(input)).resolves.toEqual({ kind: "turn", delivery: terminal });
      expect(input.backlog.deliveries).toEqual([first]);
      await expect(nextTurnDelivery(input)).resolves.toEqual({ kind: "turn", delivery: first });
    },
  );

  it("services ready authorization before a buffered completion batch", async () => {
    const input = batchingInput();
    const backlog = backlogOf(completion("task_0"), completion("task_1"));
    const next = await nextTurnDelivery({
      ...input,
      backlog,
      commandInbox: createMockInbox([authorizationRead()], true),
    });
    expect(next.kind).toBe("authorization");
    expect(backlog.deliveries).toHaveLength(2);
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });
});
