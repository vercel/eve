import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { ChannelFrom } from "eve/channels";
import { emptySessionView, foldEvents } from "eve/events";

import {
  createBoardChannel,
  endRenewal,
  keepBoardClaim,
  renewBeforeTask,
  renewDuringCall,
  settleAfterCall,
  type BoardChannelState,
} from "../extension/lib/board-channel.ts";
import { createBoardClient } from "../extension/lib/client.ts";
import { createWatch, DEFAULT_WATCH_CHANNEL } from "../extension/lib/watches.ts";
import { recorder, startBoard } from "./helpers.ts";

const settings = () => ({ profile: "helper" });
const client = () => createBoardClient(settings());

interface CompiledBoardChannel {
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
    handler(
      request: Request,
      args: {
        from: ChannelFrom<BoardChannelState>;
        waitUntil(promise: Promise<unknown>): void;
      },
    ): Promise<Response>;
  }[];
  receive(
    input: { message: string; target: { channel: string; text: string } },
    ctx: { from: ChannelFrom<BoardChannelState> },
  ): Promise<unknown>;
  readonly adapter: {
    createAdapterContext(base: { state: BoardChannelState; session: unknown }): unknown;
    deliver(payload: unknown, ctx: unknown): Promise<void>;
    readonly instrumentation: { metadata(state: BoardChannelState): Record<string, unknown> };
  };
}

const compiledOf = (channel: unknown) => channel as CompiledBoardChannel;
const compiled = () => compiledOf(createBoardChannel(settings));

const emptyState = (): BoardChannelState => ({
  channel: null,
  task: null,
  threadId: null,
});

function viewWithCall(callId: string, name: string) {
  return foldEvents(emptySessionView(), [
    {
      data: { callId, capability: { kind: "tool", name }, owner: { kind: "turn", turnId: "t-1" } },
      meta: { at: new Date().toISOString(), position: { index: 0, line: 1 } },
      type: "call.requested",
    },
  ] as never);
}

async function claimedTask(
  as: (person: string, path: string, body?: unknown) => Promise<any>,
  lease = 300,
) {
  const task = (await as("alice", "/tasks", { channel: "work/a", text: "Fix the limiter." })).task;
  const claim = await client().claimReady({
    channel: "work/",
    from: ["vercel:user:alice"],
    lease,
  });
  assert.ok(claim !== null);
  const { task: _root, ...held } = claim;
  const state: BoardChannelState = { channel: "work/a", task: held, threadId: task.id };
  return { state, task };
}

function noteRecorder() {
  const notes: string[] = [];
  const board = {
    async reply(input: { readonly text: string }) {
      notes.push(input.text);
      return {};
    },
  };
  return { board: board as never, notes };
}

test("the wake route answers at once and drains matches in the background, one drain at a time", async () => {
  const { as } = await startBoard();
  await createWatch({
    action: { type: "converse" },
    client: client(),
    id: "w-wake01",
    instructions: "Summarize it.",
    tail: "incidents",
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  const posted = (await as("alice", "/messages", { channel: "incidents", text: "Down." })).message;
  const { deliveries, from } = recorder();
  const wake = compiled().routes.find((route) => route.path === "/eve/v1/board/wake")!;
  const request = () => new Request("https://agent.test/eve/v1/board/wake", { method: "POST" });

  const pending: Promise<unknown>[] = [];
  const args = { from, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  const first = await wake.handler(request(), args);
  const second = await wake.handler(request(), args);
  assert.deepEqual(
    [wake.method, first.status, second.status, pending.length],
    ["POST", 202, 202, 1],
  );
  await Promise.all(pending);
  for (let attempt = 0; attempt < 10 && deliveries.length === 0; attempt += 1) {
    pending.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await wake.handler(request(), args);
    await Promise.all(pending);
  }

  assert.deepEqual(
    deliveries.map((entry) => [entry.address, entry.message, entry.options.state?.watch]),
    [[`w-wake01:thread:${posted.thread}`, "Down.", "w-wake01"]],
  );
});

test("the default channel also serves legacy POST /board/wake, and a custom route replaces both", async () => {
  const { as } = await startBoard();
  await createWatch({
    action: { type: "converse" },
    client: client(),
    id: "w-legacy",
    instructions: "Summarize it.",
    tail: "incidents",
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  const posted = (await as("alice", "/messages", { channel: "incidents", text: "Legacy wake." }))
    .message;
  const { deliveries, from } = recorder();
  const defaultRoutes = compiled().routes;
  assert.deepEqual(
    defaultRoutes.map((route) => `${route.method} ${route.path}`),
    ["POST /eve/v1/board/wake", "POST /board/wake"],
  );
  const legacy = defaultRoutes.find((route) => route.path === "/board/wake")!;
  const pending: Promise<unknown>[] = [];
  const args = { from, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  for (let attempt = 0; attempt < 10 && deliveries.length === 0; attempt += 1) {
    pending.length = 0;
    const response = await legacy.handler(
      new Request("https://agent.test/board/wake", { method: "POST" }),
      args,
    );
    assert.equal(response.status, 202);
    await Promise.all(pending);
    if (deliveries.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`w-legacy:thread:${posted.thread}`],
  );

  const customFromOption = compiledOf(createBoardChannel(settings, { route: "/eve/v1/acme/" }));
  assert.deepEqual(
    customFromOption.routes.map((route) => `${route.method} ${route.path}`),
    ["POST /eve/v1/acme/wake"],
  );

  const customFromSettings = compiledOf(
    createBoardChannel(() => ({ ...settings(), route: "/eve/v1/team-board" })),
  );
  assert.deepEqual(
    customFromSettings.routes.map((route) => `${route.method} ${route.path}`),
    ["POST /eve/v1/team-board/wake"],
  );
});

test("deliver records the turn's message and claim, and metadata never carries the claim token", async () => {
  await startBoard();
  const channel = compiled();
  const state = emptyState();
  const ctx = channel.adapter.createAdapterContext({ session: { id: "s-1" }, state });
  const until = new Date(Date.now() + 300_000).toISOString();
  await channel.adapter.deliver(
    {
      state: {
        noSync: true,
        task: { epoch: 1, taskId: "t-1", token: "claim-token-123", until },
      },
    },
    ctx,
  );

  assert.deepEqual([state.noSync, state.task?.taskId], [true, "t-1"]);
  const metadata = channel.adapter.instrumentation.metadata(state);
  assert.deepEqual(metadata.boardTask, { id: "t-1", until });
  assert.doesNotMatch(JSON.stringify(metadata), /claim-token-123/u);
});

test("receive starts a board thread and sends the message to its session", async () => {
  await startBoard();
  const { deliveries, from } = recorder();
  await compiled().receive(
    { message: "Check the deploy.", target: { channel: "dev", text: "Deploy check" } },
    { from },
  );

  const [summary] = await client().threads({ channel: "dev", limit: 1 });
  assert.equal(summary?.message.text, "Deploy check");
  assert.deepEqual(
    deliveries.map((entry) => [entry.address, entry.message]),
    [[`helper:thread:${summary?.message.thread}`, "Check the deploy."]],
  );
});

test("only a settle tool's call settles the held task", async () => {
  const { as } = await startBoard();
  const { state, task } = await claimedTask(as);
  const { board, notes } = noteRecorder();
  const output = { result: "Fixed in #12.", settled: "completed", task: task.id };

  await settleAfterCall(client(), { board, state }, viewWithCall("c-1", "board__post"), {
    callId: "c-1",
    outcome: "completed",
    output,
  });
  assert.notEqual(state.task, null);
  assert.equal((await client().thread(task.id)).message.task?.state, "claimed");

  await settleAfterCall(client(), { board, state }, viewWithCall("c-2", "board__complete_task"), {
    callId: "c-2",
    outcome: "completed",
    output,
  });
  assert.equal(state.task, null);
  assert.equal((await client().thread(task.id)).message.task?.state, "completed");
  assert.deepEqual(notes, []);
});

test("a settlement the board refuses drops the claim and says so in the thread", async () => {
  const { as } = await startBoard();
  const { state, task } = await claimedTask(as);
  const { board, notes } = noteRecorder();

  await settleAfterCall(client(), { board, state }, viewWithCall("c-1", "board__complete_task"), {
    callId: "c-1",
    outcome: "completed",
    output: { result: "x".repeat(1_500), settled: "completed", task: task.id },
  });

  assert.equal(state.task, null);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /couldn't mark task #\d+ completed on the board/u);
});

function unavailable(path: string, times: number) {
  const boardFetch = globalThis.fetch;
  let failed = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (failed < times && new URL(request.url).pathname.endsWith(path)) {
      failed += 1;
      return Response.json(
        { error: { code: "unavailable", message: "Try again." } },
        { status: 503 },
      );
    }
    return await boardFetch(request);
  };
  return { failures: () => failed };
}

const completed = (task: string) => ({
  callId: "c-1",
  outcome: "completed",
  output: { result: "Done.", settled: "completed", task },
});

test("a settlement retries while the board is briefly unavailable", async () => {
  const { as } = await startBoard();
  const { state, task } = await claimedTask(as);
  const { board, notes } = noteRecorder();
  const outage = unavailable(`/tasks/${task.id}/complete`, 1);

  await settleAfterCall(
    client(),
    { board, state },
    viewWithCall("c-1", "board__complete_task"),
    completed(task.id),
  );

  assert.equal(outage.failures(), 1);
  assert.equal((await client().thread(task.id)).message.task?.state, "completed");
  assert.deepEqual(notes, []);
});

test("a settlement gives up after a few tries and says so in the thread", async () => {
  const { as } = await startBoard();
  const { state, task } = await claimedTask(as);
  const { board, notes } = noteRecorder();
  const outage = unavailable(`/tasks/${task.id}/complete`, Number.POSITIVE_INFINITY);

  await settleAfterCall(
    client(),
    { board, state },
    viewWithCall("c-1", "board__complete_task"),
    completed(task.id),
  );

  assert.equal(outage.failures(), 3);
  assert.equal(state.task, null);
  assert.match(notes[0] ?? "", /Its claim runs out within the hour/u);
  assert.equal((await client().thread(task.id)).message.task?.state, "claimed");
});

test("subagent calls renew the claim in full, once a minute however many start together", async () => {
  const { as, calls } = await startBoard();
  const { state, task } = await claimedTask(as, 3600);
  const leftFor = (ms: number) => new Date(Date.now() + ms).toISOString();

  state.task = { ...state.task!, until: leftFor(1_201_000) };
  await keepBoardClaim(client(), state);
  assert.equal(renewalsOf(calls, task.id), 0);

  for (let call = 0; call < 10; call += 1) await renewBeforeTask(client(), state);
  assert.equal(renewalsOf(calls, task.id), 1);
  assert.ok(Date.parse(state.task!.until) - Date.now() > 3_500_000);

  state.task = { ...state.task!, until: leftFor(3_600_000 - 61_000) };
  await renewBeforeTask(client(), state);
  assert.equal(renewalsOf(calls, task.id), 2);
});

test("a claim near the end of its lease is renewed", async () => {
  const { as } = await startBoard();
  const { state } = await claimedTask(as);
  const soon = new Date(Date.now() + 10_000).toISOString();
  state.task = { ...state.task!, until: soon };

  await keepBoardClaim(client(), state);

  assert.ok(state.task !== null && Date.parse(state.task.until) > Date.parse(soon));
});

function fakeIntervals(t: { after(fn: () => void): void }) {
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  return async () => {
    mock.timers.tick(30_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
}

const renewalsOf = (calls: readonly string[], task: string) =>
  calls.filter((call) => call === `POST /tasks/${task}/renew`).length;

test("on a board that caps leases at five minutes, a running call renews every 30 seconds, with one timer for parallel calls", async (t) => {
  const { as, calls } = await startBoard({ leaseCap: 300 });
  const { state, task } = await claimedTask(as);
  const tick = fakeIntervals(t);
  const leased = state.task!.until;

  renewDuringCall(client, state, "c-1");
  renewDuringCall(client, state, "c-2");
  await tick();
  assert.equal(renewalsOf(calls, task.id), 1);
  endRenewal(state, "c-1");
  assert.ok(Date.parse(state.task!.until) > Date.parse(leased));
  await tick();
  assert.equal(renewalsOf(calls, task.id), 2);
  endRenewal(state, "c-2");
  await tick();
  assert.equal(renewalsOf(calls, task.id), 2);
});

test("a running call leaves a claim with most of its lease left alone", async (t) => {
  const { as, calls } = await startBoard();
  const { state, task } = await claimedTask(as, 3600);
  const tick = fakeIntervals(t);

  renewDuringCall(client, state, "c-1");
  await tick();
  await tick();
  endRenewal(state, "c-1");

  assert.equal(renewalsOf(calls, task.id), 0);
});

test("a lost claim stops renewing and clears the session's claim when the call settles", async (t) => {
  const { as, calls } = await startBoard({ leaseCap: 300 });
  const { state, task } = await claimedTask(as);
  const tick = fakeIntervals(t);
  const claim = state.task!;
  await client().held(claim).release();

  renewDuringCall(client, state, "c-1");
  await tick();
  await tick();
  assert.equal(renewalsOf(calls, task.id), 1);
  endRenewal(state, "c-1");
  assert.equal(state.task, null);
});

test("settling the task while another call runs stops renewing its claim", async (t) => {
  const { as, calls } = await startBoard({ leaseCap: 300 });
  const { state, task } = await claimedTask(as);
  const tick = fakeIntervals(t);
  const { board } = noteRecorder();

  renewDuringCall(client, state, "c-long");
  renewDuringCall(client, state, "c-done");
  endRenewal(state, "c-done");
  await settleAfterCall(
    client(),
    { board, state },
    viewWithCall("c-done", "board__complete_task"),
    {
      callId: "c-done",
      outcome: "completed",
      output: { result: "Done.", settled: "completed", task: task.id },
    },
  );
  await tick();
  endRenewal(state, "c-long");

  assert.equal(state.task, null);
  assert.equal(renewalsOf(calls, task.id), 0);
});

test("the end of a turn stops renewing even with a call still open", async (t) => {
  const { as, calls } = await startBoard();
  const { state, task } = await claimedTask(as);
  const tick = fakeIntervals(t);

  renewDuringCall(client, state, "c-1");
  endRenewal(state);
  await tick();
  assert.equal(renewalsOf(calls, task.id), 0);
  assert.notEqual(state.task, null);
});
