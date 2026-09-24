import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/session/next-input.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import { answerTaskInput } from "#tasks/owner-body.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));
vi.mock("#tasks/owner-body.js", async (importOriginal) => ({
  ...(await importOriginal()),
  answerTaskInput: vi.fn(),
}));
vi.mock("#tasks/deadlines.js", () => ({ applyTaskDeadlinesStep: vi.fn() }));
beforeEach(() => {
  vi.mocked(answerTaskInput).mockReset();
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

  it("applies a task deadline while idle and keeps waiting for input", async () => {
    const signal = {
      kind: "task.deadline" as const,
      ownerRunId: "owner-1",
      wakeAt: "2026-09-24T14:00:00.000Z",
    };
    const afterDeadline = createTestSessionState({ sessionId: "ses-after-deadline" });
    vi.mocked(applyTaskDeadlinesStep).mockResolvedValue({
      events: [],
      replies: [],
      results: [],
      serializedContext: {},
      sessionState: afterDeadline,
    });
    const input = batchingInputFor([]);
    const inbox = createMockInbox([
      { result: { done: false, value: signal } },
      messageRead("next turn"),
    ]);

    await expect(nextTurnDelivery({ ...input, inbox })).resolves.toMatchObject({
      delivery: { payloads: [{ message: "next turn" }] },
      kind: "turn",
    });
    expect(applyTaskDeadlinesStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signal }),
    );
    expect(input.cursor.sessionState).toBe(afterDeadline);
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

  it("resumes authorization after a consumed no-op cancel", async () => {
    // A cancel with no active turn is consumed without producing a parent
    // turn; the wait continues and the callback must still resume the challenge.
    const inbox = createMockInbox([cancelRead(), authorizationRead()]);

    const next = await nextTurnDelivery(waitInput(inbox));

    expect(next.kind).toBe("authorization-resume");
  });

  it("surfaces a cancel while the parked session still owes its last turn's result", async () => {
    const owed = vi.fn(() => true);
    const inbox = createMockInbox([cancelRead()]);

    const next = await nextTurnDelivery({ ...waitInput(inbox), ownsParkedWork: owed });

    expect(next).toEqual({ kind: "cancel-parked" });
    expect(owed).toHaveBeenCalledTimes(1);
  });

  it("drops a cancel while parked when nothing is owed, and never surfaces a reset", async () => {
    const idle = createMockInbox([cancelRead(), authorizationRead()]);
    await expect(
      nextTurnDelivery({ ...waitInput(idle), ownsParkedWork: () => false }),
    ).resolves.toMatchObject({ kind: "authorization-resume" });

    const queue = new SessionInputQueue();
    const reset = createMockInbox([{ result: { done: false, value: { kind: "reset" } } }]);
    await expect(
      nextTurnDelivery({ ...waitInput(reset), ownsParkedWork: () => true, queue }),
    ).resolves.toEqual({ kind: "reset" });
  });

  it("does not let buffered deliveries bypass a ready authorization callback", async () => {
    const inbox = createMockInbox([]);
    const queue = queueOf({ kind: "deliver", payloads: [{ message: "later" }] });
    queue.enqueueAuthorization(authorizationCallbackPayload.payloads);

    const next = await nextTurnDelivery({ ...waitInput(inbox), queue });

    expect(next.kind).toBe("authorization-resume");
    expect(queue.pendingCount).toBe(1);
  });

  it("buffers deliveries until the authorization callback arrives", async () => {
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
  vi.mocked(answerTaskInput).mockImplementation(async (_cursor, delivery) => ({
    kind: "continue",
    remainder: delivery,
  }));
  return { ...input, queue: queueOf(...bufferedDeliveries) };
}

describe("nextTurnDelivery routing", () => {
  it("keeps waiting instead of starting a parent turn for a fully routed child response", async () => {
    const sessionState = createTestSessionState({
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      sessionId: "session",
      version: 1,
    });
    vi.mocked(answerTaskInput)
      .mockResolvedValueOnce({ kind: "continue", remainder: undefined })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { kind: "deliver", payloads: [{ message: "ordinary" }] },
      });
    const commands = [
      { kind: "send" as const, payload: { inputResponses: [{ requestId: "child-request" }] } },
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
    expect(answerTaskInput).toHaveBeenCalledTimes(2);
  });
});
