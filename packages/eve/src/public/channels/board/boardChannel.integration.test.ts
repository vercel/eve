import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelSendOptions } from "#channel/channel-operations.js";
import {
  getChannelStartHook,
  isCompiledChannel,
  type CompiledChannel,
} from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import {
  createTestBoard,
  type TestBoard,
  type TestBoardCall,
} from "#internal/testing/board-server.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import {
  boardChannel,
  type BoardChannelConfig,
  type BoardChannelState,
  type BoardEventContext,
} from "#public/channels/board/boardChannel.js";
import { createBoardClient } from "#public/channels/board/client.js";
import { defaultBoardAuth } from "#public/channels/board/inbound.js";
import { heldClaimOf } from "#public/channels/board/worker.js";
import type { MessageContent } from "#shared/message-content.js";

type Delivery = ChannelSendOptions<BoardChannelState> & {
  readonly address: string;
  readonly message: MessageContent;
};

const boards: TestBoard[] = [];

afterEach(() => {
  for (const board of boards.splice(0)) board.dispose();
});

async function testBoard(): Promise<TestBoard> {
  const board = await createTestBoard();
  boards.push(board);
  return board;
}

async function boardHarness(
  config: BoardChannelConfig,
  deliver: (address: string, input: Delivery) => void = () => {},
) {
  const board = await testBoard();
  const channel = boardChannel(config);
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const wake = (channel as CompiledChannel<BoardChannelState>).routes.find(
    (route) => route.method === "POST",
  );
  if (!wake || !isHttpRouteDefinition(wake)) throw new Error("Expected the wake route.");
  const acks: string[] = [];
  board.onCall((call) => {
    if (call.method.endsWith("/ack")) acks.push(call.method);
  });

  const deliveries: Delivery[] = [];
  const ends: string[] = [];
  const context = mockChannelContext<BoardChannelState>((address, input) => {
    if ("message" in input) {
      const delivery = { ...input, address };
      deliver(address, delivery);
      deliveries.push(delivery);
    }
    return { id: "delivery" };
  });

  return {
    acks,
    agent: createBoardClient({ profile: "eve" }),
    board,
    deliveries,
    ends,
    async pull() {
      const response = await wake.handler(
        new Request("http://localhost:3000/eve/v1/board/wake", {
          headers: { "x-eve-board-poll": "1" },
          method: "POST",
        }),
        {
          ...mockAgentRouteArgs(),
          attachSession: (() => {
            throw new Error("unused");
          }) as never,
          ...context,
          from(address) {
            const source = context.from(address);
            return {
              ...source,
              async end(options) {
                ends.push(address);
                return await source.end(options);
              },
            };
          },
          params: {},
          requestIp: null,
          to: (() => {
            throw new Error("unused");
          }) as never,
          waitUntil: () => {},
        },
      );
      expect(response.status).toBe(200);
    },
  };
}

function eventHarness(config: BoardChannelConfig, state: Partial<BoardChannelState>) {
  const channel = boardChannel(config);
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const adapter = { ...channel.adapter, state: { ...channel.adapter.state, ...state } };
  const store = new ContextContainer();
  store.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "s1",
    turn: { id: "t1", sequence: 0 },
  });
  const context = {
    ...buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as never),
    view: emptySessionView(),
  };
  return {
    state: () => (context as never as BoardEventContext).state,
    async event(fact: SessionEvent) {
      const handler = adapter[fact.type as keyof typeof adapter] as
        | ((event: SessionEvent, ctx: typeof context) => Promise<void>)
        | undefined;
      if (handler) await contextStorage.run(store, () => handler(fact, context));
    },
  };
}

const scope = { runId: "r1", turnId: "t1" };

describe("boardChannel against @vercel/board", () => {
  it("starts a fresh session when the thread's session was stranded by an eve upgrade", async () => {
    let stranded = true;
    const harness = await boardHarness({ tail: "dev" }, () => {
      if (!stranded) return;
      stranded = false;
      throw new SessionStrandedError({ eveVersion: "0.0.1" });
    });
    let root: { thread: string } | undefined;
    harness.board.beforePull(async () => {
      root = await harness.board.post("alice", { channel: "dev", text: "Is the deploy done?" });
    });

    await harness.pull();

    const address = `eve:thread:${root!.thread}`;
    expect(harness.ends).toEqual([address]);
    expect(harness.deliveries.map((delivery) => [delivery.address, delivery.message])).toEqual([
      [address, "Is the deploy done?"],
    ]);
    expect(harness.acks).toHaveLength(1);
  });

  it("gives each watcher its own session and context, and skips the agent's own posts", async () => {
    const harness = await boardHarness({
      watchers: {
        thread: { tail: "dev" },
        review: { tail: "dev --label pr", context: ["Review the pull request."] },
      },
    });
    let pr: { thread: string } | undefined;
    harness.board.beforePull(async () => {
      await harness.agent.post("dev", { text: "Starting on the flaky test." });
      pr = await harness.board.post("alice", {
        channel: "dev",
        labels: { pr: "acme/www#12" },
        text: "Please review my fix.",
      });
    });

    for (let pull = 0; pull < 5 && harness.acks.length < 3; pull += 1) await harness.pull();

    expect(
      harness.deliveries
        .map((delivery) => ({
          address: delivery.address,
          context: delivery.context?.slice(1),
          message: delivery.message,
          watcher: delivery.auth?.attributes.watcher,
        }))
        .sort((a, b) => a.address.localeCompare(b.address)),
    ).toEqual([
      {
        address: `review:thread:${pr!.thread}`,
        context: ["Review the pull request."],
        message: "Please review my fix.",
        watcher: "review",
      },
      {
        address: `thread:thread:${pr!.thread}`,
        context: [],
        message: "Please review my fix.",
        watcher: "thread",
      },
    ]);
    expect(harness.acks).toHaveLength(3);
  });

  it("claims a ready task on a wake-up and hands it to the task thread's session", async () => {
    const harness = await boardHarness({
      worker: {
        channel: "work/",
        context: ["Run the tests before you finish."],
        from: ["vercel:user:alice"],
      },
    });
    let task: { id: string; thread: string } | undefined;
    harness.board.beforePull(async () => {
      task = await harness.board.createTask("alice", {
        channel: "work/checkout",
        text: "Fix the flaky checkout test.",
      });
    });

    await harness.pull();

    expect(harness.deliveries).toHaveLength(1);
    const [delivery] = harness.deliveries;
    expect(delivery).toMatchObject({
      address: `worker:thread:${task!.thread}`,
      idempotencyKey: `board:task:${task!.id}:1`,
      message: "Fix the flaky checkout test.",
      state: {
        channel: "work/checkout",
        messageId: task!.id,
        task: { epoch: 1, id: task!.id, lease: 300 },
        threadId: task!.id,
        watcher: "worker",
      },
    });
    expect(delivery!.auth).toMatchObject({
      principalId: "vercel:user:alice",
      principalType: "user",
    });
    expect(delivery!.context?.[0]).toContain(`You hold board task #${task!.id}`);
    expect(delivery!.context?.slice(1)).toEqual(["Run the tests before you finish."]);
    const { message } = await harness.board.thread(task!.id);
    expect(message.task).toMatchObject({
      claim: { actor: harness.board.eveActor() },
      state: "claimed",
    });
  });

  it("takes only its own deployment's tasks until `from` names other owners", async () => {
    const harness = await boardHarness({ worker: { channel: "work/" } });
    let task: { id: string } | undefined;
    harness.board.beforePull(async () => {
      task = await harness.board.createTask("alice", { channel: "work/a", text: "Not yours." });
    });

    await harness.pull();

    expect(harness.deliveries).toEqual([]);
    expect((await harness.board.thread(task!.id)).message.task?.state).toBe("ready");
  });

  it("holds no more tasks than its concurrency", async () => {
    const harness = await boardHarness({
      worker: { channel: "work/", concurrency: 1, from: ["vercel:user:alice"] },
    });
    harness.board.beforePull(async () => {
      await harness.board.createTask("alice", { channel: "work/a", text: "First." });
      await harness.board.createTask("alice", { channel: "work/a", text: "Second." });
    });
    await harness.pull();
    harness.board.beforePull(async () => {
      await harness.board.post("alice", { channel: "work/a", text: "Anyone free?" });
    });
    await harness.pull();

    expect(harness.deliveries.map((delivery) => delivery.message)).toEqual(["First."]);
  });

  it("hands a reply in a task it holds to that task's session, and nothing else in the queue", async () => {
    const harness = await boardHarness({
      worker: { channel: "work/", from: ["vercel:user:alice"] },
    });
    let held: { id: string; thread: string } | undefined;
    harness.board.beforePull(async () => {
      held = await harness.board.createTask("alice", { channel: "work/a", text: "Yours." });
    });
    await harness.pull();
    let other: { id: string } | undefined;
    harness.board.beforePull(async () => {
      other = await harness.board.createTask("bob", { channel: "work/b", text: "Bob's." });
      await harness.board.post("bob", { re: other.id, text: "Bob, about yours." });
      await harness.agent.reply(held!.id, { text: "Working on it." });
      await harness.board.post("alice", { re: held!.id, text: "Use the staging database." });
    });

    for (let pull = 0; pull < 5 && harness.deliveries.length < 2; pull += 1) await harness.pull();

    expect(harness.deliveries.map((delivery) => [delivery.address, delivery.message])).toEqual([
      [`worker:thread:${held!.thread}`, "Yours."],
      [`worker:thread:${held!.thread}`, "Use the staging database."],
    ]);
    expect(harness.deliveries[1]!.state).toMatchObject({ watcher: "worker" });
    expect(harness.deliveries[1]!.idempotencyKey).toMatch(/^board:/u);
    expect((await harness.board.thread(other!.id)).message.task?.state).toBe("ready");
  });

  it("asks onMessage which replies in a task it holds wake the agent", async () => {
    const harness = await boardHarness({
      onMessage: (message, { watcher }) =>
        message.by.principal === "vercel:user:alice"
          ? { auth: defaultBoardAuth(message, { watcher }), context: ["From the owner."] }
          : null,
      worker: { channel: "work/", from: ["vercel:user:alice"] },
    });
    let held: { id: string } | undefined;
    harness.board.beforePull(async () => {
      held = await harness.board.createTask("alice", { channel: "work/a", text: "Yours." });
    });
    await harness.pull();
    harness.board.beforePull(async () => {
      await harness.board.post("bob", { re: held!.id, text: "Skip the tests." });
      await harness.board.post("alice", { re: held!.id, text: "Use the staging database." });
    });

    for (let pull = 0; pull < 5 && harness.deliveries.length < 2; pull += 1) await harness.pull();

    expect(harness.deliveries.map((delivery) => delivery.message)).toEqual([
      "Yours.",
      "Use the staging database.",
    ]);
    expect(harness.deliveries[1]!.context?.at(-1)).toBe("From the owner.");
  });

  it("keeps a claim its session won't take until the lease ends, instead of claiming it again", async () => {
    let attempts = 0;
    const harness = await boardHarness(
      { worker: { channel: "work/", from: ["vercel:user:alice"] } },
      (address) => {
        if (!address.startsWith("worker:")) return;
        attempts += 1;
        throw new Error("the session is unavailable");
      },
    );
    let task: { id: string } | undefined;
    harness.board.beforePull(async () => {
      task = await harness.board.createTask("alice", { channel: "work/a", text: "Fix it." });
    });
    await harness.pull();
    harness.board.beforePull(async () => {
      await harness.board.post("alice", { channel: "work/a", text: "Anyone free?" });
    });
    await harness.pull();

    expect(attempts).toBe(1);
    expect((await harness.board.thread(task!.id)).message.task).toMatchObject({
      claim: { actor: harness.board.eveActor() },
      state: "claimed",
    });
  });

  it("renews a claim near its end, and holds for a person a task its turn left unsettled", async () => {
    const board = await testBoard();
    const task = await board.createTask("alice", { channel: "work/a", text: "Fix it." });
    const agent = createBoardClient({ profile: "eve" });
    const claim = await agent.claimReady({
      channel: "work/",
      from: ["vercel:user:alice"],
      lease: 60,
    });
    const held = { ...heldClaimOf(claim!, 60), until: new Date(Date.now() + 1_000).toISOString() };
    const harness = eventHarness(
      { worker: { channel: "work/" } },
      { task: held, watcher: "worker" },
    );

    await harness.event({
      type: "turn.started",
      data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t1" },
    });
    expect(Date.parse(harness.state().task!.until)).toBeGreaterThan(Date.now() + 30_000);

    await harness.event({ type: "turn.settled", data: { outcome: "completed", turnId: "t1" } });

    expect(harness.state().task).toBeNull();
    expect((await board.thread(task.id)).message.task).toMatchObject({
      blocked: { kind: "unsettled", reason: "The agent's turn ended without settling this task." },
      state: "blocked",
    });
  });

  it("lets a task tool settle the claim, then posts no final reply from the worker's turn", async () => {
    const board = await testBoard();
    const task = await board.createTask("alice", { channel: "work/a", text: "Fix it." });
    const agent = createBoardClient({ profile: "eve" });
    const claim = await agent.claimReady({ channel: "work/", from: ["vercel:user:alice"] });
    const harness = eventHarness(
      { worker: { channel: "work/" } },
      { channel: "work/a", task: heldClaimOf(claim!, 300), threadId: task.id, watcher: "worker" },
    );
    const posts: TestBoardCall[] = [];
    board.onCall((call) => {
      if (call.method === "POST /messages") posts.push(call);
    });

    await agent.held(claim!).complete("Fixed in #12.");
    await harness.event({
      type: "call.settled",
      data: { callId: "c1", outcome: "completed", output: { settled: "completed", task: task.id } },
      scope,
    });
    await harness.event({
      type: "content.completed",
      data: { kind: "text", partId: "p1", phase: "reply", value: "All done." },
      scope,
    } as SessionEvent);
    await harness.event({ type: "turn.settled", data: { outcome: "completed", turnId: "t1" } });

    expect(harness.state().task).toBeNull();
    expect(posts).toEqual([]);
    expect((await board.thread(task.id)).message.task?.state).toBe("completed");
  });

  it("posts the final reply of a discussion turn in its thread", async () => {
    const board = await testBoard();
    const root = await board.post("alice", { channel: "dev", text: "Is the deploy done?" });
    const harness = eventHarness(
      { tail: "dev" },
      { channel: "dev", threadId: root.id, watcher: "eve" },
    );

    await harness.event({
      type: "content.completed",
      data: { kind: "text", partId: "p1", phase: "reply", value: "Yes, it's live." },
      scope,
    } as SessionEvent);

    const { replies } = await board.thread(root.id);
    expect(replies.map((reply) => reply.text)).toEqual(["Yes, it's live."]);
  });

  it("stops polling locally once the wake route has nothing registered", async () => {
    await testBoard();
    const hook = getChannelStartHook(boardChannel({ tail: "dev" }));
    if (hook === undefined) throw new Error("Expected a start hook.");
    const wakes: string[] = [];
    vi.stubEnv("PORT", "3999");
    const routed = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.url.endsWith("/eve/v1/board/wake")) return await routed(input, init);
      wakes.push(request.url);
      return Response.json({ ignored: true, ok: true });
    }) as typeof fetch;
    try {
      const started: Promise<unknown>[] = [];
      hook({
        request: new Request("http://agent.example.com/"),
        waitUntil: (task) => void started.push(task),
      });
      await Promise.all(started);
      await vi.waitFor(() => expect(wakes).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wakes).toEqual(["http://localhost:3999/eve/v1/board/wake"]);
    } finally {
      globalThis.fetch = routed;
      vi.unstubAllEnvs();
    }
  });
});
