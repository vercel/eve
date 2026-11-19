import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelFrom, ChannelSendOptions } from "eve/channels";

import { drainMatches, type BoardChannelState } from "../extension/lib/board-channel.ts";
import { createBoardClient, resolveBoardTarget } from "../extension/lib/client.ts";
import {
  defineBoardUnwatchTool,
  defineBoardWatchesTool,
  defineBoardWatchTool,
} from "../extension/lib/tools.ts";
import { createWatch, DEFAULT_WATCH_CHANNEL, heldRegistration } from "../extension/lib/watches.ts";
import { EVE_PRINCIPAL, runTool, startBoard } from "./helpers.ts";

const settings = () => ({ profile: "helper" });
const client = () => createBoardClient(resolveBoardTarget(settings()));

interface Delivery {
  readonly address: string;
  readonly message: unknown;
  readonly options: ChannelSendOptions<BoardChannelState>;
}

function fakeFrom(
  send: (address: string, message: unknown, options: Delivery["options"]) => void,
): ChannelFrom<BoardChannelState> {
  return ((address: string) => ({
    async end() {},
    async send(message: unknown, options: Delivery["options"]) {
      send(address, message, options);
      return { id: "delivery" };
    },
  })) as never;
}

function recorder() {
  const deliveries: Delivery[] = [];
  const from = fakeFrom((address, message, options) => {
    deliveries.push({ address, message, options });
  });
  return { deliveries, from };
}

async function wake(from: ChannelFrom<BoardChannelState>, expect: "some" | "none") {
  if (expect === "none") await new Promise((resolve) => setTimeout(resolve, 200));
  return await drainMatches({
    client: client(),
    from,
    name: undefined,
    poll: expect === "some",
    watchChannel: () => DEFAULT_WATCH_CHANNEL,
  });
}

const registers = (calls: readonly string[]) =>
  calls.filter((call) => /^(POST|PUT) \/watchers$/u.test(call));

test("a watch the agent creates wakes one turn with its stored instructions, and outlives a removed sibling", async () => {
  const { as, calls } = await startBoard();
  const watch = defineBoardWatchTool(settings);
  const watches = defineBoardWatchesTool(settings);

  assert.deepEqual((await runTool(watches, {}, { callId: "l0" })).watches, []);

  const incidents = {
    instructions: "Summarize the impact and ask who's leading the response.",
    tail: "incidents",
  };
  const first = await runTool(watch, incidents, { callId: "c1", sessionId: "session-a" });
  const retried = await runTool(watch, incidents, { callId: "c1", sessionId: "session-a" });
  assert.match(first.id, /^w-[0-9a-z]{6}$/u);
  assert.equal(retried.id, first.id);
  const second = await runTool(
    watch,
    { instructions: "Note the version that shipped.", tail: "deploys" },
    { callId: "c1", sessionId: "session-b" },
  );
  assert.notEqual(second.id, first.id);

  const listed = await runTool(watches, { details: true }, { callId: "l1" });
  assert.deepEqual(
    listed.watches
      .map((entry: { id: string; tail: string; instructions: string }) => [
        entry.id,
        entry.tail,
        entry.instructions,
      ])
      .sort(),
    [
      [first.id, "incidents", incidents.instructions],
      [second.id, "deploys", "Note the version that shipped."],
    ].sort(),
  );
  const records = await client().threads({
    channel: DEFAULT_WATCH_CHANNEL,
    label: [`eve-watch=${first.id}`],
  });
  assert.equal(records.length, 1);

  calls.length = 0;
  const { deliveries, from } = recorder();
  const posted = (
    await as("alice", "/messages", { channel: "incidents", text: "Checkout is down." })
  ).message;
  await wake(from, "some");
  await wake(from, "none");

  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery!.address, `${first.id}:thread:${posted.thread}`);
  assert.equal(delivery!.message, "Checkout is down.");
  assert.match(delivery!.options.idempotencyKey!, /^board:/u);
  assert.match(delivery!.options.context![0]!, new RegExp(incidents.instructions, "u"));
  assert.deepEqual(delivery!.options.state, {
    channel: "incidents",
    messageId: posted.id,
    threadId: posted.id,
    watch: first.id,
  });

  await client().reply(posted.id, { text: "Looking into it." });
  await wake(from, "none");
  assert.equal(deliveries.length, 1);

  const removed = await runTool(
    defineBoardUnwatchTool(settings),
    { id: first.id },
    { callId: "u1" },
  );
  assert.deepEqual(removed, { id: first.id, removed: true });
  assert.deepEqual(Object.keys((await heldRegistration(client()))!.watch), [second.id]);
  const retired = await client().threads({
    channel: DEFAULT_WATCH_CHANNEL,
    label: [`eve-watch=${first.id}`],
  });
  assert.equal(retired[0]!.message.labels["eve-watch-state"], "retired");

  calls.length = 0;
  await as("alice", "/messages", { channel: "incidents", text: "Still down." });
  const shipped = (await as("alice", "/messages", { channel: "deploys", text: "Shipped v42." }))
    .message;
  await wake(from, "some");
  await wake(from, "none");
  assert.deepEqual(
    deliveries.slice(1).map((entry) => entry.address),
    [`${second.id}:thread:${shipped.thread}`],
  );
  assert.deepEqual(registers(calls), []);
});

test("a claiming watch claims a ready task and dispatches to the task's thread", async () => {
  const { as } = await startBoard();
  const created = await runTool(
    defineBoardWatchTool(settings),
    {
      claim: { channel: "work/", from: ["vercel:user:alice"] },
      instructions: "Fix what the task describes, then complete it.",
      tail: "work/",
    },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const task = (await as("alice", "/tasks", { channel: "work/a", text: "Fix the flaky test." }))
    .task;

  await wake(from, "some");

  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery!.address, `${created.id}:thread:${task.thread}`);
  assert.equal(delivery!.message, "Fix the flaky test.");
  assert.match(delivery!.options.idempotencyKey!, new RegExp(`^board:task:${task.id}:1$`, "u"));
  assert.equal(delivery!.options.state?.task?.id, task.id);
  const { message } = await client().thread(task.id);
  assert.equal(message.task?.state, "claimed");
  assert.equal(message.task?.claim?.actor, `${EVE_PRINCIPAL}+helper`);
});

test("the watch tool refuses tails outside the agent's scope and callers who may not configure it", async () => {
  await startBoard();
  const watch = defineBoardWatchTool(() => ({
    can: { "incidents/": ["read", "post"] as const },
    profile: "helper",
  }));
  const instructions = "Summarize it.";

  await assert.rejects(
    runTool(watch, { instructions, tail: "--mentions @helper" }, { callId: "c1" }),
    /must name the channel it watches/u,
  );
  await assert.rejects(
    runTool(watch, { instructions, tail: "eve-config/" }, { callId: "c2" }),
    /can't cover "eve-config\/watches"/u,
  );
  await assert.rejects(
    runTool(watch, { instructions, tail: "payroll" }, { callId: "c3" }),
    /may not read "payroll"/u,
  );
  await assert.rejects(
    runTool(
      watch,
      { instructions, tail: "incidents/web" },
      {
        auth: { attributes: { actor_kind: "external" }, authenticator: "board-watcher" },
        callId: "c4",
      },
    ),
    /Only a person on the team/u,
  );
});

test("a watch change waits for another replica's change and keeps it", async () => {
  await startBoard();
  const board = client();
  const create = (id: string) =>
    createWatch({
      action: { type: "converse" },
      client: board,
      id,
      instructions: `Instructions for ${id}.`,
      tail: `channel-${id}`,
      watchChannel: DEFAULT_WATCH_CHANNEL,
    });
  await create("w-first");
  const [lock] = await board.threads({
    channel: DEFAULT_WATCH_CHANNEL,
    label: ["eve-lock=registration"],
  });
  const held = await board.claim(lock!.message.id, 30);

  const waiting = create("w-second");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(Object.keys((await heldRegistration(board))!.watch), ["w-first"]);
  await board.register({
    url: null,
    watch: { "w-first": { tail: "channel-w-first" }, "w-other": { tail: "channel-w-other" } },
  });
  await board.held(held).release();
  await waiting;

  assert.deepEqual(Object.keys((await heldRegistration(board))!.watch).sort(), [
    "w-first",
    "w-other",
    "w-second",
  ]);
});

test("a match the session couldn't take is delivered again with the same idempotency key", async () => {
  const { as } = await startBoard();
  await runTool(
    defineBoardWatchTool(settings),
    { instructions: "Summarize it.", tail: "incidents" },
    { callId: "c1" },
  );
  const keys: string[] = [];
  let refused = false;
  const from = fakeFrom((_address, _message, options) => {
    keys.push(options.idempotencyKey!);
    if (!refused) {
      refused = true;
      throw new Error("the session is busy");
    }
  });
  await as("alice", "/messages", { channel: "incidents", text: "Checkout is down." });

  await wake(from, "some");
  for (let pull = 0; pull < 5 && keys.length < 2; pull += 1) await wake(from, "some");

  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
});
