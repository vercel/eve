import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/session/next-input.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type {
  SessionInbox,
  SessionInboxHandle,
  SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { pendingContinuation } from "#definitions/continuation.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));
vi.mock("../route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));
vi.mock("#definitions/continuation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#definitions/continuation.js")>()),
  pendingContinuation: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(routeDeliverToChildren).mockReset();
  vi.mocked(pendingContinuation).mockReset();
});

interface ScriptedRead {
  readonly result: IteratorResult<SessionInboxPayload>;
}

type MockInbox = SessionInbox &
  Pick<SessionInboxHandle, "awaitingHandover" | "whenHandoverSettled">;

function createMockInbox(reads: readonly ScriptedRead[]): MockInbox {
  const remaining = [...reads];

  return {
    awaitingHandover: false,
    async whenHandoverSettled() {},
    claimedTokens: [],
    ownerRunId: () => "owner-1",
    takeLeading<T extends SessionInboxPayload>(
      accepts: (payload: SessionInboxPayload) => payload is T,
    ): T[] {
      const taken: T[] = [];
      for (let next = remaining[0]?.result.value; next !== undefined && accepts(next);) {
        taken.push(next);
        remaining.shift();
        next = remaining[0]?.result.value;
      }
      return taken;
    },
    async claimSessionHook() {},
    async claimSessionHooks() {},
    drain() {
      return remaining.splice(0).map((read) => read.result.value);
    },
    hasPending() {
      return remaining.length > 0;
    },
    whenPending: () => new Promise<void>(() => {}),
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

function waitInput(inbox: MockInbox): WaitInput {
  const cursor = createCursor(inbox);
  return {
    hasWorkingTasks: () => false,
    ignore: async () => {},
    inbox: inbox,
    cursor,
    queue: new SessionInputQueue([]),
  };
}

function createCursor(
  inbox: Pick<SessionInbox, "claimSessionHooks">,
  state = sessionState,
): SessionStateCursor {
  return new SessionStateCursor({
    history: [],
    inbox: inbox,
    sessionWritable: new WritableStream<Uint8Array>(),
    serializedContext: {},
    sessionState: state,
  });
}

function queueOf(...deliveries: DeliverHookPayload[]): SessionInputQueue {
  const queue = new SessionInputQueue([]);
  for (const delivery of deliveries) queue.enqueueDelivery(delivery);
  return queue;
}

describe("nextTurnDelivery", () => {
  const continuation: DeliverHookPayload = {
    idempotencyKey: "ses:continue:turn_0",
    kind: "deliver",
    payloads: [{ message: "Keep going." }],
    turnPolicy: "queue",
  };

  it("admits a hook's continuation once nothing else waits", async () => {
    vi.mocked(pendingContinuation).mockReturnValue(continuation);
    const input = batchingInputFor([]);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: { payloads: [{ message: "Keep going." }] },
      kind: "turn",
    });
  });

  it("returns end ahead of queued deliveries and continuations when a hook ended the session", async () => {
    vi.mocked(pendingContinuation).mockReturnValue(continuation);
    const input = batchingInputFor([{ kind: "deliver", payloads: [{ message: "Queued." }] }]);
    input.cursor.serializedContext["eve.reactions"] = { sessionEnd: { hook: "finish-job" } };

    await expect(nextTurnDelivery(input)).resolves.toEqual({ hook: "finish-job", kind: "end" });
  });

  it("returns end when routeSelectedDelivery ends the session before starting the routed turn", async () => {
    const inbox = createMockInbox([messageRead("parent follow-up")]);
    vi.mocked(routeDeliverToChildren).mockResolvedValueOnce({
      kind: "continue",
      remainder: { kind: "deliver", payloads: [{ message: "parent follow-up" }] },
      stateDelta: {
        serializedContext: {
          kind: "value",
          value: { "eve.reactions": { sessionEnd: { hook: "route-end" } } },
        },
      },
    });

    await expect(nextTurnDelivery(waitInput(inbox))).resolves.toEqual({
      hook: "route-end",
      kind: "end",
    });
  });

  it("holds a continuation behind input an awaited handover still holds back", async () => {
    vi.mocked(pendingContinuation).mockReturnValue(continuation);
    let settled = false;
    const reads = [messageRead("Alice asks for the appendix.")];
    const inbox = {
      ...createMockInbox(reads),
      get awaitingHandover() {
        return !settled;
      },
      hasPending: () => settled && reads.length > 0,
      async next() {
        return reads.shift()?.result.value;
      },
      async whenHandoverSettled() {
        settled = true;
      },
    };

    await expect(nextTurnDelivery({ ...batchingInputFor([]), inbox })).resolves.toMatchObject({
      delivery: { payloads: [{ message: "Alice asks for the appendix." }] },
      kind: "turn",
    });
  });

  it("retains an accepted cancel's identity when background tasks must stop", async () => {
    const inbox = createMockInbox([
      { result: { done: false, value: { kind: "cancel", deliveryId: "cancel-tasks" } } },
    ]);
    const input = waitInput(inbox);
    input.hasWorkingTasks = () => true;
    expect(await nextTurnDelivery(input)).toEqual({
      kind: "cancel-working-tasks",
      origin: { deliveryId: "cancel-tasks" },
    });
  });

  it("batches one principal's adjacent queued deliveries with their latest claims", async () => {
    const auth: SessionAuthContext = {
      attributes: { scopes: ["read"], team: "support" },
      authenticator: "slack",
      issuer: "workspace",
      principalId: "bob",
      principalType: "user",
      subject: "bob-subject",
    };
    const refreshed = { ...auth, attributes: { scopes: ["read", "write"], team: "support" } };
    const first = authenticatedDelivery("first", auth);
    const second = authenticatedDelivery("second", refreshed);
    const input = batchingInputFor([first, second]);

    const next = await nextTurnDelivery(input);

    expect(next).toMatchObject({
      kind: "turn",
      delivery: {
        auth: refreshed,
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

  describe("deliveries the hub sends one after the other", () => {
    const rosterAuth: SessionAuthContext = {
      attributes: {},
      authenticator: "roster",
      principalId: "roster:me",
      principalType: "user",
    };
    const hubPost = (
      message: string,
      auth: SessionAuthContext = rosterAuth,
    ): SessionInboxPayload => ({
      auth,
      idempotencyKey: `post-${message}`,
      kind: "deliver",
      payloads: [{ message }],
      turnPolicy: "queue",
    });
    const read = (payload: SessionInboxPayload): ScriptedRead => ({
      result: { done: false, value: payload },
    });
    const inboxOf = (...payloads: SessionInboxPayload[]) => ({
      ...batchingInputFor([]),
      inbox: createMockInbox(payloads.map(read)),
    });

    it("folds two posts that both reached the idle session's inbox before its loop woke", async () => {
      const input = inboxOf(hubPost("first"), hubPost("second"));

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }, { message: "second" }] },
        kind: "turn",
      });
      expect(input.queue.pendingCount).toBe(0);
    });

    it("folds the posts still in the inbox into the ones already queued", async () => {
      const input = batchingInputFor([
        { ...hubPost("queued"), kind: "deliver" } as DeliverHookPayload,
      ]);
      const inbox = createMockInbox([read(hubPost("late"))]);

      await expect(nextTurnDelivery({ ...input, inbox })).resolves.toMatchObject({
        delivery: { payloads: [{ message: "queued" }, { message: "late" }] },
        kind: "turn",
      });
    });

    it("leaves a cancel that follows a post in the inbox for the turn that post starts", async () => {
      const input = inboxOf(
        hubPost("first"),
        { kind: "cancel", deliveryId: "stop" },
        hubPost("second"),
      );

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }] },
        kind: "turn",
      });
      expect(input.inbox.hasPending()).toBe(true);
    });

    it("keeps a post from another principal out of the turn, whichever order they arrive in", async () => {
      const other = { ...rosterAuth, principalId: "roster:someone-else" };
      const input = inboxOf(hubPost("mine"), hubPost("theirs", other), hubPost("mine again"));

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { auth: rosterAuth, payloads: [{ message: "mine" }] },
        kind: "turn",
      });
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { auth: other, payloads: [{ message: "theirs" }] },
        kind: "turn",
      });
      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: { auth: rosterAuth, payloads: [{ message: "mine again" }] },
        kind: "turn",
      });
    });
  });

  describe("holding an idle session's queued message", () => {
    const me = slackAuth("me");
    const other = slackAuth("someone-else");
    const post = (
      message: string,
      options: { auth?: SessionAuthContext; turnPolicy?: "queue" | "steer" } = {},
    ): SessionInboxPayload => ({
      auth: options.auth ?? me,
      idempotencyKey: `post-${message}`,
      kind: "deliver",
      payloads: [{ message }],
      ...(options.turnPolicy !== undefined && { turnPolicy: options.turnPolicy }),
    });
    const queued = (message: string, auth?: SessionAuthContext) =>
      post(message, { auth, turnPolicy: "queue" });

    function parkedSession(ms: number | undefined) {
      const arrived: SessionInboxPayload[] = [];
      const waiters = new Set<() => void>();
      const wake = () => {
        for (const waiter of waiters) waiter();
        waiters.clear();
      };
      const base = createMockInbox([]);
      const inbox: MockInbox = {
        ...base,
        hasPending: () => arrived.length > 0,
        takeLeading<T extends SessionInboxPayload>(
          accepts: (payload: SessionInboxPayload) => payload is T,
        ): T[] {
          const taken: T[] = [];
          while (arrived[0] !== undefined && accepts(arrived[0])) taken.push(arrived.shift() as T);
          return taken;
        },
        async whenPending() {
          while (arrived.length === 0) await new Promise<void>((resolve) => waiters.add(resolve));
        },
        async next() {
          while (arrived.length === 0) await new Promise<void>((resolve) => waiters.add(resolve));
          return arrived.shift();
        },
      };
      let fire!: () => void;
      const timers: number[] = [];
      const timer = new Promise<void>((resolve) => (fire = resolve));
      const input = {
        ...batchingInputFor([]),
        inbox,
        ...(ms !== undefined && {
          hold: {
            ms,
            until: (at: number) => {
              timers.push(at);
              return timer;
            },
          },
        }),
      };
      const settled = async <T>(promise: Promise<T>): Promise<T | "waiting"> => {
        const result = await Promise.race([
          promise,
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
        ]);
        return result;
      };
      return {
        elapse: () => fire(),
        input,
        push(payload: SessionInboxPayload) {
          arrived.push(payload);
          wake();
        },
        settled,
        timers,
      };
    }

    it("starts the turn only once the hold has elapsed", async () => {
      const session = parkedSession(120_000);
      session.push(queued("first"));

      const next = nextTurnDelivery(session.input);

      expect(await session.settled(next)).toBe("waiting");
      expect(session.timers).toHaveLength(1);
      expect(session.timers[0]! - Date.now()).toBeGreaterThan(110_000);
      session.elapse();
      await expect(next).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }] },
        kind: "turn",
      });
    });

    it("holds a message that reaches the session while it is already waiting for input", async () => {
      const session = parkedSession(120_000);
      const next = nextTurnDelivery(session.input);
      expect(await session.settled(next)).toBe("waiting");

      session.push(queued("first"));
      expect(await session.settled(next)).toBe("waiting");
      session.elapse();

      await expect(next).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }] },
        kind: "turn",
      });
    });

    it("folds the queued messages that arrive during the hold into the one turn", async () => {
      const session = parkedSession(120_000);
      session.push(queued("first"));
      const next = nextTurnDelivery(session.input);
      expect(await session.settled(next)).toBe("waiting");

      session.push(queued("second"));
      expect(await session.settled(next)).toBe("waiting");
      session.push(queued("third"));
      expect(await session.settled(next)).toBe("waiting");
      session.elapse();

      await expect(next).resolves.toMatchObject({
        delivery: {
          payloads: [{ message: "first" }, { message: "second" }, { message: "third" }],
        },
        kind: "turn",
      });
      expect(session.timers).toHaveLength(1);
    });

    it("starts at once when a steering message arrives, and ends the hold", async () => {
      const session = parkedSession(120_000);
      session.push(queued("first"));
      const next = nextTurnDelivery(session.input);
      expect(await session.settled(next)).toBe("waiting");

      session.push(post("steer now"));

      await expect(session.settled(next)).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }, { message: "steer now" }] },
        kind: "turn",
      });
    });

    it("never holds a steering message that reaches the idle session", async () => {
      const session = parkedSession(120_000);
      session.push(post("hello"));

      await expect(session.settled(nextTurnDelivery(session.input))).resolves.toMatchObject({
        delivery: { payloads: [{ message: "hello" }] },
        kind: "turn",
      });
      expect(session.timers).toHaveLength(0);
    });

    it.each([0, undefined])("starts at once with a hold of %s", async (ms) => {
      const session = parkedSession(ms);
      session.push(queued("first"));

      await expect(session.settled(nextTurnDelivery(session.input))).resolves.toMatchObject({
        delivery: { payloads: [{ message: "first" }] },
        kind: "turn",
      });
      expect(session.timers).toHaveLength(0);
    });

    it("keeps another principal's message out of the held turn's auth", async () => {
      const session = parkedSession(120_000);
      session.push(queued("mine", me));
      const next = nextTurnDelivery(session.input);
      expect(await session.settled(next)).toBe("waiting");

      session.push(queued("theirs", other));
      expect(await session.settled(next)).toBe("waiting");
      session.elapse();

      await expect(next).resolves.toMatchObject({
        delivery: { auth: me, payloads: [{ message: "mine" }] },
        kind: "turn",
      });
      await expect(session.settled(nextTurnDelivery(session.input))).resolves.toMatchObject({
        delivery: { auth: other, payloads: [{ message: "theirs" }] },
        kind: "turn",
      });
    });

    it("lets another principal's steering message end the hold without joining the held turn", async () => {
      const session = parkedSession(120_000);
      session.push(queued("bot post", me));
      const next = nextTurnDelivery(session.input);
      expect(await session.settled(next)).toBe("waiting");

      session.push(post("human post", { auth: other }));

      await expect(session.settled(next)).resolves.toMatchObject({
        delivery: { auth: me, payloads: [{ message: "bot post" }] },
        kind: "turn",
      });
      await expect(session.settled(nextTurnDelivery(session.input))).resolves.toMatchObject({
        delivery: { auth: other, payloads: [{ message: "human post" }] },
        kind: "turn",
      });
    });

    it("does not hold a message that was already waiting behind a running turn", async () => {
      const session = parkedSession(120_000);
      session.input.queue.enqueueDelivery(queued("waited") as DeliverHookPayload);

      await expect(session.settled(nextTurnDelivery(session.input))).resolves.toMatchObject({
        delivery: { payloads: [{ message: "waited" }] },
        kind: "turn",
      });
      expect(session.timers).toHaveLength(0);
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

  it("batches one delegated call's queued messages and stops at another call", async () => {
    const auth = slackAuth("alice");
    const fromCall = (message: string, callId: string): DeliverHookPayload => ({
      ...authenticatedDelivery(message, auth),
      caller: {
        callId,
        replyTo: { kind: "hook", token: `${message}-reply` },
        subagentName: "keeper",
      },
    });
    const input = batchingInputFor([
      fromCall("first", "call-1"),
      fromCall("correction", "call-1"),
      fromCall("other", "call-2"),
    ]);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: {
        caller: { callId: "call-1", replyTo: { token: "correction-reply" } },
        payloads: [{ message: "first" }, { message: "correction" }],
      },
      kind: "turn",
    });
    await expect(nextTurnDelivery(input)).resolves.toMatchObject({
      delivery: { caller: { callId: "call-2" }, payloads: [{ message: "other" }] },
      kind: "turn",
    });
  });

  it.each([{ authenticator: "other" }, { issuer: "other" }, { principalType: "service" }])(
    "does not batch when the principal changes: %j",
    async (change) => {
      const auth = slackAuth("alice");
      const first = authenticatedDelivery("first", auth);
      const second = authenticatedDelivery("second", { ...auth, ...change });
      const input = batchingInputFor([first, second]);

      await expect(nextTurnDelivery(input)).resolves.toMatchObject({
        delivery: first,
        kind: "turn",
      });
      expect(input.queue.pendingCount).toBe(1);
    },
  );

  it.each([null, undefined])("does not batch deliveries with auth %j", async (auth) => {
    const first: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "first" }] };
    const second: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "second" }] };
    const input = batchingInputFor([first, second]);

    await expect(nextTurnDelivery(input)).resolves.toMatchObject({ delivery: first, kind: "turn" });
    expect(input.queue.pendingCount).toBe(1);
  });

  it("drops a sign-in callback that arrives between turns and waits for the next message", async () => {
    const inbox = createMockInbox([authorizationRead(), messageRead("next question")]);

    const next = await nextTurnDelivery({ ...batchingInputFor([]), inbox });

    expect(next).toMatchObject({
      delivery: { payloads: [{ message: "next question" }] },
      kind: "turn",
    });
  });

  it("reports session closure while parked", async () => {
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
        stateDelta: { sessionState: { kind: "value", value: retiredState } },
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { kind: "deliver", payloads: [{ message: "parent turn" }] },
        stateDelta: {},
      });

    const next = await nextTurnDelivery(waitInput(inbox));

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
  vi.mocked(routeDeliverToChildren).mockImplementation(async ({ delivery }) => ({
    kind: "continue",
    remainder: delivery,
    stateDelta: {},
  }));
  return { ...input, queue: queueOf(...bufferedDeliveries) };
}
