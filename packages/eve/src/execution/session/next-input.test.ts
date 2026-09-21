import { createTestSessionState } from "#internal/testing/session-state.js";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/session/next-input.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));
vi.mock("../route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));
vi.mock("../cancel-indexed-session-tasks-step.js", () => ({
  cancelAllIndexedSessionTasksStep: vi.fn(),
}));

import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";

beforeEach(() => {
  vi.mocked(routeDeliverToChildren).mockReset();
  vi.mocked(cancelAllIndexedSessionTasksStep).mockReset();
  vi.mocked(cancelAllIndexedSessionTasksStep).mockImplementation(async ({ sessionState }) => ({
    sessionState,
  }));
});

interface ScriptedRead {
  readonly result: IteratorResult<SessionInboxPayload>;
}

/** Scripted inbox: serves reads in order. */
function createMockInbox(reads: readonly ScriptedRead[]): SessionInbox {
  const remaining = [...reads];

  return {
    claimedTokens: [],
    async claimSessionHook() {},
    async claimSessionHooks() {},
    drain() {
      return remaining.splice(0).map((read) => read.result.value);
    },
    hasPending() {
      return remaining.length > 0;
    },
    async next() {
      const read = remaining.shift();
      if (read === undefined) throw new Error("Mock inbox exhausted.");
      if (read.result.done) return undefined;
      return read.result.value;
    },
    onDelivery() {
      return () => {};
    },
    onInterrupt() {
      return () => {};
    },
    restore() {},
  };
}

const authorizationCallbackPayload = {
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
} satisfies SessionInboxPayload;

function authorizationRead(): ScriptedRead {
  return { result: { done: false, value: authorizationCallbackPayload } };
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
  const cursor = createCursor(inbox);
  return {
    expectedAttemptIds: new Set(["attempt-1"]),
    inbox: inbox,
    cursor,
    queue: new SessionInputQueue(),
  };
}

function createCursor(
  inbox: Pick<SessionInbox, "claimSessionHooks">,
  state = sessionState,
): SessionStateCursor {
  return new SessionStateCursor({
    inbox: inbox,
    sessionWritable: new WritableStream<Uint8Array>(),
    serializedContext: {},
    sessionState: state,
  });
}

function queueOf(...deliveries: DeliverHookPayload[]): SessionInputQueue {
  const queue = new SessionInputQueue();
  for (const delivery of deliveries) queue.enqueueDelivery(delivery);
  return queue;
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
    expect(input.queue.pendingCount).toBe(0);
  });

  it("reports a sole conversation delivery with its single admission", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "continue on the accepting deployment" }],
    };
    const input = batchingInputFor([delivery]);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery,
      handoffEligible: false,
      kind: "turn",
    });
  });

  it("considers a sole pumped delivery an idle handoff candidate", async () => {
    const input = batchingInputFor([]);
    const inbox = createMockInbox([messageRead("next turn")]);

    await expect(nextTurnDelivery({ ...input, inbox })).resolves.toMatchObject({
      kind: "turn",
      handoffEligible: true,
      delivery: { payloads: [{ message: "next turn" }] },
    });
  });

  it("does not hand off the first delivery in a buffered burst", async () => {
    const input = batchingInputFor([]);
    const inbox = createMockInbox([messageRead("first"), messageRead("second")]);

    await expect(nextTurnDelivery({ ...input, inbox })).resolves.toMatchObject({
      kind: "turn",
      handoffEligible: false,
      delivery: { payloads: [{ message: "first" }] },
    });
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
    expect(input.queue.pendingCount).toBe(0);
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

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({ delivery: first, kind: "turn" });
    expect(input.queue.pendingCount).toBe(1);
  });

  it.each([null, undefined])("does not batch deliveries with auth %j", async (auth) => {
    const first: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "first" }] };
    const second: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "second" }] };
    const input = batchingInputFor([first, second]);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({ delivery: first, kind: "turn" });
    expect(input.queue.pendingCount).toBe(1);
  });

  it("surfaces an authorization callback as its own instruction", async () => {
    const inbox = createMockInbox([authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization-resume");
    if (next.kind !== "authorization-resume") throw new Error("unreachable");
    expect(next.payloads).toEqual(authorizationCallbackPayload.payloads);
  });

  it("cancels indexed tasks and keeps waiting for ordinary parked activity", async () => {
    const inbox = createMockInbox([cancelRead({ tasks: true }), authorizationRead()]);
    const input = waitInput(inbox);

    const next = await nextTurnDelivery(input);

    expect(next.kind).toBe("authorization-resume");
    expect(cancelAllIndexedSessionTasksStep).toHaveBeenCalledWith({
      serializedContext: input.cursor.serializedContext,
      sessionState: input.cursor.sessionState,
    });
  });

  it("resumes authorization after a consumed no-op cancel", async () => {
    // A cancel with no active turn is consumed without producing a parent
    // turn; the wait continues and the callback must still resume the challenge.
    const inbox = createMockInbox([cancelRead(), authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization-resume");
  });

  it("does not let buffered deliveries bypass a ready authorization callback", async () => {
    const inbox = createMockInbox([]);
    const queue = queueOf({ kind: "deliver", payloads: [{ message: "later" }] });
    queue.enqueueAuthorization(authorizationCallbackPayload.payloads);

    const next = await nextTurnDelivery({ ...waitInput(inbox), queue });

    expect(next.kind).toBe("authorization-resume");
    expect(queue.pendingCount).toBe(1);
  });

  it("buffers task deliveries until the authorization callback arrives", async () => {
    const inbox = createMockInbox([messageRead("deferred"), authorizationRead()]);
    const queue = new SessionInputQueue();

    const next = await nextTurnDelivery({ ...waitInput(inbox), queue, deferDeliveries: true });

    expect(next.kind).toBe("authorization-resume");
    expect(queue.pendingCount).toBe(1);
  });

  it("reports session closure while waiting for authorization", async () => {
    const inbox = createMockInbox([{ result: { done: true, value: undefined } }]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next).toMatchObject({ kind: "closed" });
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
      expectedAttemptIds: undefined,
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
  return { ...input, queue: queueOf(...bufferedDeliveries) };
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
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => commands.splice(0)),
      hasPending: vi.fn(() => commands.length > 0),
      next: vi.fn(async () => commands.shift()),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };

    const cursor = createCursor(inbox, sessionState);
    const result = await nextTurnDelivery({
      inbox,
      cursor,
      queue: new SessionInputQueue(),
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

function terminalDelivery(taskId: string, status: "failed" | "cancelled"): DeliverHookPayload {
  const view: TaskView = {
    taskId,
    metadata: { kind: "subagent", name: "worker" },
    ...(status === "failed"
      ? { status, lastOutput: { type: "error", data: "failed" } }
      : { status }),
  };
  return {
    kind: "deliver",
    taskDeliveryId: `${taskId}:ready:${status}`,
    payloads: [{ message: status, task: { views: [view] } }],
  };
}

function report(delivery: DeliverHookPayload): DeliverHookPayload {
  return {
    ...delivery,
    payloads: delivery.payloads.map(({ task: _task, ...payload }) => payload),
  };
}

function batchingInput(count = 100, crossTurn = false) {
  const input = waitInput(createMockInbox([]));
  const taskSessionState = {
    ...sessionState,
    snapshot: {
      session: {
        sessionId: "session",
        continuationToken: "token",
        history: [],
        agent: { system: "" },
        state: {
          "eve.workflowTool": {
            version: 3,
            runs: Array.from({ length: count }, (_, index) => ({
              callId: `task_${index}`,
              toolName: "worker",
              lifetime: "session" as const,
              origin: { turnId: crossTurn ? `turn-${index + 1}` : "turn-1", stepIndex: 0 },
              address: { runId: `run-${index}`, hookToken: `inbox-${index}` },
              task: {
                taskId: `task_${index}`,
                cohortId: "task_0",
                dispatchContext: { auth: { current: null, initiator: null } },
                metadata: { kind: "subagent", name: "worker" },
              },
            })).concat([
              {
                callId: "other-cohort",
                toolName: "worker",
                lifetime: "session" as const,
                origin: { turnId: "turn-2", stepIndex: 0 },
                address: { runId: "other-run", hookToken: "other-inbox" },
                task: {
                  taskId: "other-cohort",
                  cohortId: "other-cohort",
                  dispatchContext: { auth: { current: null, initiator: null } },
                  metadata: { kind: "subagent", name: "worker" },
                },
              },
            ]),
          },
        },
      },
    },
  };
  input.cursor = createCursor({ claimSessionHooks: async () => {} }, taskSessionState);
  vi.mocked(routeDeliverToChildren).mockImplementation(
    async ({ delivery, sessionState, serializedContext }) => ({
      kind: "continue",
      remainder: report(delivery),
      sessionState,
      serializedContext,
    }),
  );
  return { ...input };
}

describe("buffered task completion batching", () => {
  beforeEach(() => vi.mocked(routeDeliverToChildren).mockReset());
  afterEach(() => vi.mocked(routeDeliverToChildren).mockReset());

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps routed %s remainders behind the cohort barrier",
    async (status) => {
      const input = batchingInput(2);
      const original =
        status === "completed" ? completion("task_0") : terminalDelivery("task_0", status);
      const admission = input.queue.enqueueDelivery(original);
      assert(admission !== undefined);
      const routed = {
        ...original,
        payloads: original.payloads.map(({ task: _task, ...payload }) => payload),
      };
      input.queue.replaceDelivery(admission.sequence, routed);
      const last = completion("task_1");
      input.inbox = createMockInbox([
        messageRead("still working"),
        { result: { done: false, value: last } },
      ]);
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { payloads: [{ message: "still working" }] },
      });
      expect(input.queue.pendingCount).toBe(1);
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { payloads: [...routed.payloads, ...report(last).payloads] },
      });
      expect(input.queue.pendingCount).toBe(0);
    },
  );

  it("delivers 100 buffered sibling results and their metadata in one parent turn", async () => {
    const input = batchingInput();
    const deliveries = Array.from({ length: 100 }, (_, index) => completion(`task_${index}`));
    const queue = queueOf(...deliveries);
    const next = await nextTurnDelivery({ ...input, queue });

    expect(next).toMatchObject({
      kind: "turn",
      delivery: {
        taskDeliveryId: "task_0:ready:completed",
        payloads: deliveries.flatMap((delivery) => report(delivery).payloads),
        deliveryMetadata: deliveries.map((delivery, payloadIndex) => ({
          ...delivery.deliveryMetadata![0],
          payloadIndex,
        })),
      },
    });
    expect(queue.pendingCount).toBe(0);
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(101);
  });

  it.each([
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
      const queue = queueOf(first, second, boundary, later);
      const next = await nextTurnDelivery({ ...input, queue });
      expect(next).toMatchObject({ kind: "turn", delivery: report(boundary) });
      expect(queue.pendingCount).toBe(3);
    },
  );

  it.each([false, true])(
    "keeps the cohort across a user turn (cross-turn launches: %s)",
    async (crossTurn) => {
      const input = batchingInput(3, crossTurn);
      const first = completion("task_0");
      const second = completion("task_1");
      const last = completion("task_2");
      input.queue.enqueueDelivery(first);
      input.inbox = createMockInbox([
        { result: { done: false, value: second } },
        messageRead("user question"),
        { result: { done: false, value: last } },
      ]);

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: { payloads: [{ message: "user question" }] },
      });
      expect(input.queue.pendingCount).toBe(2);
      expect(routeDeliverToChildren).toHaveBeenCalledTimes(3);

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: {
          payloads: [
            ...report(first).payloads,
            ...report(second).payloads,
            ...report(last).payloads,
          ],
        },
      });
      expect(input.queue.pendingCount).toBe(0);
      expect(routeDeliverToChildren).toHaveBeenCalledTimes(5);
    },
  );

  it("batches a whole cohort when every completion arrives after the active turn", async () => {
    const input = batchingInput(3);
    const deliveries = [completion("task_0"), completion("task_1"), completion("task_2")];
    input.inbox = createMockInbox(
      deliveries.map((value) => ({ result: { done: false, value }, source: "session" })),
    );
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: deliveries.flatMap((delivery) => report(delivery).payloads) },
    });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(4);
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
    for (const delivery of [first, settlement, last]) input.queue.enqueueDelivery(delivery);
    vi.mocked(routeDeliverToChildren).mockImplementation(
      async ({ delivery, sessionState, serializedContext }) => ({
        kind: "continue",
        remainder: delivery.payloads.some((payload) => payload.task?.agentRequests !== undefined)
          ? undefined
          : report(delivery),
        sessionState,
        serializedContext,
      }),
    );

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...report(first).payloads, ...report(last).payloads] },
    });
    expect(vi.mocked(routeDeliverToChildren).mock.calls.map(([call]) => call.delivery)).toEqual([
      first,
      settlement,
      last,
      expect.objectContaining({ payloads: [...report(first).payloads, ...report(last).payloads] }),
    ]);
    expect(input.queue.pendingCount).toBe(0);
  });

  it("combines siblings across buffered deliveries from another cohort", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    const last = completion("task_1");
    const other = completion("other-cohort");
    for (const delivery of [first, other, last]) input.queue.enqueueDelivery(delivery);
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...report(first).payloads, ...report(last).payloads] },
    });
    expect(input.queue.pendingCount).toBe(1);
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: report(other),
    });
  });

  it.each(["clear", "compact", "reset", "session-timeout"] as const)(
    "services %s without releasing an incomplete cohort",
    async (kind) => {
      const input = batchingInput(2);
      const first = completion("task_0");
      input.queue.enqueueDelivery(first);
      const value: SessionInboxPayload =
        kind === "session-timeout" ? { kind, ownerRunId: "owner-1" } : { kind };
      input.inbox = createMockInbox([{ result: { done: false, value } }]);
      await expect(nextTurnDelivery(input)).resolves.toEqual({
        kind: kind === "session-timeout" ? "expired" : kind,
      });
      expect(input.queue.pendingCount).toBe(1);
      expect(routeDeliverToChildren).toHaveBeenCalledOnce();
    },
  );

  it("does not wait for a cancelled sibling whose notifications are discarded", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    input.queue.enqueueDelivery(first);
    input.inbox = createMockInbox([cancelRead({ taskId: "task_1" })]);
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: report(first),
    });
  });

  it("waits for a recorded cancellation's notification before reporting its cohort", () => {
    const queue = new SessionInputQueue();
    const cohorts = new Map([
      ["task_0", "cohort"],
      ["task_1", "cohort"],
    ]);
    queue.enqueueDelivery(completion("task_0"));
    expect(queue.takeNext(cohorts)).toBeUndefined();
    queue.enqueueDelivery(terminalDelivery("task_1", "cancelled"));
    expect(queue.takeNext(cohorts)).toMatchObject({ kind: "turn" });
    expect(queue.pendingCount).toBe(0);
    expect(queue.enqueueDelivery(completion("task_1"))).toBeUndefined();
  });

  it.each(["failed", "cancelled"] as const)(
    "does not admit a second terminal notification with a different %s outcome",
    (status) => {
      for (const deliveries of [
        [completion("task_0"), terminalDelivery("task_0", status)],
        [terminalDelivery("task_0", status), completion("task_0")],
      ]) {
        const queue = new SessionInputQueue();
        const [first, late] = deliveries;
        if (first === undefined || late === undefined) throw new Error("Expected two deliveries.");
        expect(queue.enqueueDelivery(first)).toBeDefined();
        expect(queue.enqueueDelivery(late)).toBeUndefined();
        expect(queue.pendingCount).toBe(1);
        expect(queue.takeNext(new Map())).toBeDefined();
        expect(queue.enqueueDelivery(late)).toBeUndefined();
        expect(queue.pendingCount).toBe(0);
      }
    },
  );

  it("ignores duplicate notifications while waiting for the last sibling", async () => {
    const input = batchingInput(2);
    const first = completion("task_0");
    const last = completion("task_1");
    input.inbox = createMockInbox(
      [first, first, last].map((value) => ({
        result: { done: false, value },
        source: "session",
      })),
    );
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      kind: "turn",
      delivery: { payloads: [...report(first).payloads, ...report(last).payloads] },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "batches %s with successful siblings from the same cohort",
    async (status) => {
      const input = batchingInput(2);
      const first = completion("task_0");
      const terminal = terminalDelivery("task_1", status);
      for (const delivery of [first, terminal]) input.queue.enqueueDelivery(delivery);
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: { payloads: [...report(first).payloads, ...report(terminal).payloads] },
      });
      expect(input.queue.pendingCount).toBe(0);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "batches an all-%s cohort into one report",
    async (status) => {
      const input = batchingInput(2);
      const first = terminalDelivery("task_0", status);
      const last = terminalDelivery("task_1", status);
      for (const delivery of [first, last]) input.queue.enqueueDelivery(delivery);
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        kind: "turn",
        delivery: { payloads: [...report(first).payloads, ...report(last).payloads] },
      });
      expect(input.queue.pendingCount).toBe(0);
    },
  );

  it("services ready authorization before a buffered completion batch", async () => {
    const input = batchingInput();
    const queue = queueOf(completion("task_0"), completion("task_1"));
    queue.enqueueAuthorization(authorizationCallbackPayload.payloads);
    const next = await nextTurnDelivery({ ...input, queue, inbox: createMockInbox([]) });
    expect(next.kind).toBe("authorization-resume");
    expect(queue.pendingCount).toBe(2);
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
  });
});
