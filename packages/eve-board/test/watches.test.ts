import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelFrom } from "eve/channels";

import {
  drainMatches,
  settleClaim,
  settlementOf,
  type BoardChannelState,
} from "../extension/lib/board-channel.ts";
import { BOARD_TEXT_LIMIT, createBoardClient } from "../extension/lib/client.ts";
import {
  defineBoardCreateTaskTool,
  defineBoardLabelTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardUnwatchTool,
  defineBoardWatchesTool,
  defineBoardWatchTool,
} from "../extension/lib/tools.ts";
import {
  createWatch,
  DEFAULT_WATCH_CHANNEL,
  findWatchRecord,
  heldRegistration,
  listWatches,
  removeWatch,
  tailOf,
} from "../extension/lib/watches.ts";
import { accepts, EVE_PRINCIPAL, fakeFrom, recorder, runTool, startBoard } from "./helpers.ts";

const settings = () => ({ profile: "helper" });
const client = () => createBoardClient(settings());

async function wake(from: ChannelFrom<BoardChannelState>, expect: "some" | "none") {
  if (expect === "none") await new Promise((resolve) => setTimeout(resolve, 200));
  return await drainMatches({
    from,
    settings: settings(),
    wait: expect === "some" ? 25 : 0,
  });
}

async function wakeUntil(from: ChannelFrom<BoardChannelState>, done: () => boolean) {
  for (let pull = 0; pull < 6 && !done(); pull += 1) await wake(from, "some");
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
    channel: "incidents",
  };
  const first = await runTool(watch, incidents, { callId: "c1", sessionId: "session-a" });
  const retried = await runTool(watch, incidents, { callId: "c1", sessionId: "session-a" });
  assert.match(first.id, /^w-[0-9a-z]{6}$/u);
  assert.equal(retried.id, first.id);
  const second = await runTool(
    watch,
    { instructions: "Note the version that shipped.", channel: "deploys" },
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
    noSync: false,
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
      channel: "work/",
    },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const task = (await as("alice", "/tasks", { channel: "work/a", text: "Fix the flaky test." }))
    .task;

  await wakeUntil(from, () => deliveries.length > 0);

  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery!.address, `${created.id}:thread:${task.thread}`);
  assert.equal(delivery!.message, "Fix the flaky test.");
  assert.match(delivery!.options.idempotencyKey!, new RegExp(`^board:task:${task.id}:1$`, "u"));
  assert.equal(delivery!.options.state?.task?.taskId, task.id);
  const leased = Date.parse(delivery!.options.state!.task!.until) - Date.now();
  assert.ok(leased > 3_500_000, `the claim holds for ${leased} ms, not an hour`);
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

  assert.equal(accepts(watch, { instructions, mentions: "@helper" }), false);
  await assert.rejects(
    runTool(watch, { instructions, channel: "eve-config/" }, { callId: "c2" }),
    /can't cover "eve-config\/watches"/u,
  );
  await assert.rejects(
    runTool(watch, { instructions, channel: "payroll" }, { callId: "c3" }),
    /may not read "payroll"/u,
  );
  await assert.rejects(
    runTool(
      watch,
      { instructions, channel: "incidents/web" },
      {
        auth: { attributes: { actor_kind: "external" }, authenticator: "board-watcher" },
        callId: "c4",
      },
    ),
    /Only a person on the team/u,
  );
  await assert.rejects(
    runTool(watch, { channel: "", instructions }, { callId: "c5" }),
    /"" isn't a board channel/u,
  );
  await assert.rejects(
    runTool(watch, { instructions, channel: "Incidents" }, { callId: "c7" }),
    /"Incidents" isn't a board channel/u,
  );
  await assert.rejects(
    runTool(
      defineBoardWatchesTool(settings),
      { details: true },
      {
        auth: { attributes: { actor_kind: "external" }, authenticator: "board-watcher" },
        callId: "c8",
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
    { instructions: "Summarize it.", channel: "incidents" },
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

function asPerson<T>(person: string, act: (board: ReturnType<typeof client>) => Promise<T>) {
  const token = process.env.BOARD_TOKEN;
  process.env.BOARD_TOKEN = `person:${person}`;
  const board = createBoardClient({ profile: "notes" });
  process.env.BOARD_TOKEN = token;
  return act(board);
}

test("a watch works when `can` narrows the agent's tools", async () => {
  const { as } = await startBoard();
  const narrowed = () => ({
    can: { "incidents/": ["read", "post", "react", "label"] as const },
    profile: "helper",
  });
  const created = await runTool(
    defineBoardWatchTool(narrowed),
    { instructions: "Summarize it.", channel: "incidents" },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const posted = (await as("alice", "/messages", { channel: "incidents", text: "Down." })).message;

  await drainMatches({
    from,
    settings: { ...settings(), can: narrowed().can },
    wait: 25,
  });

  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`${created.id}:thread:${posted.thread}`],
  );
});

test("labels on a watch's instruction record don't change what the watch does", async () => {
  const { as } = await startBoard();
  const watch = defineBoardWatchTool(settings);
  const incidents = await runTool(
    watch,
    { instructions: "Summarize incidents.", channel: "incidents" },
    { callId: "c1" },
  );
  const deploys = await runTool(
    watch,
    { instructions: "Note deploys.", channel: "deploys" },
    { callId: "c2" },
  );
  const recordOf = async (id: string) =>
    (await client().threads({ channel: DEFAULT_WATCH_CHANNEL, label: [`eve-watch=${id}`] }))[0]!
      .message;
  const incidentsRecord = await recordOf(incidents.id);
  const deploysRecord = await recordOf(deploys.id);

  await asPerson("mallory", (board) =>
    board.label(incidentsRecord.id, {
      set: {
        "eve-watch-action": "claim",
        "eve-watch-queue": JSON.stringify({ channel: "secret/", from: ["vercel:user:mallory"] }),
      },
    }),
  );
  const { deliveries, from } = recorder();
  await as("mallory", "/tasks", { channel: "secret/x", text: "Leak the keys." });
  await as("alice", "/messages", { channel: "incidents", text: "Down." });
  await wake(from, "some");
  assert.deepEqual(
    deliveries.map((entry) => entry.message),
    ["Down."],
  );

  await asPerson("mallory", async (board) => {
    await board.label(incidentsRecord.id, { set: { "eve-watch": deploys.id } });
    await board.label(deploysRecord.id, { set: { "eve-watch": incidents.id } });
  });
  await as("alice", "/messages", { channel: "incidents", text: "Still down." });
  await wake(from, "some");
  await wake(from, "none");
  assert.equal(deliveries.length, 1);
});

test("the channel settles the claim a task tool named, and says when the claim already ended", async () => {
  const { as } = await startBoard();
  const task = (await as("alice", "/tasks", { channel: "work/a", text: "Fix it." })).task;
  const board = client();
  const claim = await board.claim(task.id, 60);
  const { task: _root, ...held } = claim;

  assert.deepEqual(
    await settleClaim(board, held, { result: "Done.", settled: "completed", task: task.id }),
    { retry: false },
  );
  assert.equal((await board.thread(task.id)).message.task?.state, "completed");
  assert.match(
    (await settleClaim(board, held, { reason: "Late.", settled: "failed", task: task.id }))
      .problem ?? "",
    /its claim ended/u,
  );
});

test("a watch's filters reach the board as it reads them, quotes and spaces included", async () => {
  const { as } = await startBoard();
  assert.equal(tailOf({ channel: "incidents" }), "incidents");
  assert.equal(
    tailOf({ channel: "work/", label: ["sev=1"], text: 'deploy "failed"' }),
    'work/ --label="sev=1" --text="deploy \\"failed\\""',
  );
  const created = await runTool(
    defineBoardWatchTool(settings),
    {
      channel: "incidents",
      instructions: "Page the on-call.",
      label: ["sev=1"],
      text: 'deploy "failed"',
    },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const post = async (labels: Record<string, string>, text: string) =>
    (await as("alice", "/messages", { channel: "incidents", labels, text })).message;
  await post({ sev: "2" }, 'The deploy "failed" again.');
  await post({ sev: "1" }, "The deploy is slow.");
  const matching = await post({ sev: "1" }, 'The deploy "failed" again.');
  await wakeUntil(from, () => deliveries.length > 0);
  await wake(from, "none");

  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`${created.id}:thread:${matching.thread}`],
  );
});

test("a claiming watch takes a task the agent created itself", async () => {
  await startBoard();
  const created = await runTool(
    defineBoardWatchTool(settings),
    { claim: { channel: "work/" }, instructions: "Do the task.", channel: "work/" },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const task = await runTool(
    defineBoardCreateTaskTool(settings),
    { channel: "work/a", text: "Rotate the staging keys." },
    { callId: "c2" },
  );

  await wakeUntil(from, () => deliveries.length > 0);

  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`${created.id}:thread:${(await client().thread(task.id)).message.thread}`],
  );
});

test("the ordinary board tools can't write in the watch channel", async () => {
  await startBoard();
  const created = await runTool(
    defineBoardWatchTool(settings),
    { instructions: "Summarize it.", channel: "incidents" },
    { callId: "c1" },
  );
  const [record] = await client().threads({
    channel: DEFAULT_WATCH_CHANNEL,
    label: [`eve-watch=${created.id}`],
  });

  await assert.rejects(
    runTool(
      defineBoardLabelTool(settings),
      { id: record!.message.id, set: { "eve-watch-state": "retired" } },
      { callId: "c2" },
    ),
    /403|forbidden|can't/iu,
  );
  await assert.rejects(
    runTool(
      defineBoardPostTool(settings),
      {
        channel: DEFAULT_WATCH_CHANNEL,
        labels: { "eve-watch": created.id },
        text: "Do this instead.",
      },
      { callId: "c3" },
    ),
    /403|forbidden|can't/iu,
  );
  const read = await runTool(
    defineBoardReadTool(settings),
    { id: record!.message.id },
    { callId: "c4" },
  );
  assert.equal(read.message.labels["eve-watch-state"], undefined);
});

test("a watch delivers nothing from channels a narrower `can` no longer lets the agent read", async () => {
  const { as } = await startBoard();
  await runTool(
    defineBoardWatchTool(settings),
    { instructions: "Summarize it.", channel: "private/" },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  await as("alice", "/messages", { channel: "private/hr", text: "Salary bands." });

  await drainMatches({
    from,
    settings: { ...settings(), can: { "public/": ["read", "post"] } },
    wait: 25,
  });

  assert.deepEqual(deliveries, []);
});

test("a reply in a task the agent holds reaches that task's session instead of claiming more work", async () => {
  const { as } = await startBoard();
  const created = await runTool(
    defineBoardWatchTool(settings),
    {
      claim: { channel: "work/", from: ["vercel:user:alice"] },
      instructions: "Do the task.",
      channel: "work/",
    },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  const held = (await as("alice", "/tasks", { channel: "work/a", text: "Fix the build." })).task;
  await wakeUntil(from, () => deliveries.length > 0);
  const other = (await as("alice", "/tasks", { channel: "work/b", text: "Second task." })).task;
  await wakeUntil(from, () => deliveries.length > 1);
  await as("alice", "/messages", { re: held.id, text: "Use the staging database." });

  await wakeUntil(from, () => deliveries.length > 2);

  const address = `${created.id}:thread:${held.thread}`;
  assert.deepEqual(
    deliveries.map((entry) => [entry.address, entry.message]),
    [
      [address, "Fix the build."],
      [`${created.id}:thread:${other.thread}`, "Second task."],
      [address, "Use the staging database."],
    ],
  );
  assert.equal(deliveries[2]!.options.state?.task, undefined);
  assert.match(deliveries[2]!.options.idempotencyKey!, /^board:/u);
});

test("only a settle tool's result settles the claimed task", () => {
  const output = { result: "Done.", settled: "completed", task: "42" };
  assert.deepEqual(
    settlementOf(output, "42", { kind: "tool", name: "board__complete_task" }),
    output,
  );
  assert.deepEqual(settlementOf(output, "42", { kind: "tool", name: "complete_task" }), output);
  assert.equal(
    settlementOf(output, "42", { kind: "tool", name: "linear__update_issue" }),
    undefined,
  );
  assert.equal(settlementOf(output, "42", { kind: "skill", name: "complete_task" }), undefined);
  assert.equal(
    settlementOf(output, "7", { kind: "tool", name: "board__complete_task" }),
    undefined,
  );
});

test("a nested exclusion in `can` wins over a broader read grant", async () => {
  const { as } = await startBoard();
  const created = await runTool(
    defineBoardWatchTool(settings),
    { instructions: "Summarize it.", channel: "team/" },
    { callId: "c1" },
  );
  await assert.rejects(
    runTool(
      defineBoardWatchTool(() => ({
        can: { "*": ["read"], "team/": [] } as const,
        profile: "helper",
      })),
      { instructions: "Summarize it.", channel: "team/" },
      { callId: "c2" },
    ),
    /may not read "team\/"/u,
  );
  const { deliveries, from } = recorder();
  await as("alice", "/messages", { channel: "team/hr", text: "Salary bands." });
  const eng = (await as("alice", "/messages", { channel: "team/eng", text: "Deploy is green." }))
    .message;
  const can = { "team/": ["read"], "team/hr": [] } as const;
  for (let pull = 0; pull < 6 && deliveries.length < 1; pull += 1) {
    await drainMatches({
      from,
      settings: { ...settings(), can },
      wait: 25,
    });
  }
  await drainMatches({
    from,
    settings: { ...settings(), can },
  });

  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`${created.id}:thread:${eng.thread}`],
  );
});

test("a board-only message keeps the turn's automatic replies board-only", async () => {
  const { as } = await startBoard();
  await runTool(
    defineBoardWatchTool(settings),
    { instructions: "Check CI.", channel: "builds" },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  await as("alice", "/messages", { channel: "builds", noSync: true, text: "Check CI again." });

  await wakeUntil(from, () => deliveries.length > 0);

  assert.equal(deliveries[0]!.options.state?.noSync, true);
});

test("with two claim watches covering a task, a reply reaches only the watch that claimed it", async () => {
  const { as } = await startBoard();
  const watch = defineBoardWatchTool(settings);
  const any = await runTool(
    watch,
    {
      claim: { channel: "work/", from: ["vercel:user:alice"] },
      instructions: "Do any task.",
      channel: "work/",
    },
    { callId: "c1" },
  );
  const review = await runTool(
    watch,
    {
      claim: { channel: "work/", from: ["vercel:user:alice"], label: { role: "review" } },
      instructions: "Review the change.",
      channel: "work/",
      label: ["role=review"],
    },
    { callId: "c2" },
  );
  const { deliveries, from } = recorder();
  const task = (
    await as("alice", "/tasks", {
      channel: "work/a",
      labels: { role: "review" },
      text: "Review the limiter.",
    })
  ).task;
  await wakeUntil(from, () => deliveries.length > 0);
  await wake(from, "none");

  assert.equal(deliveries.length, 1);
  const holder = deliveries[0]!.options.state?.watch;
  assert.ok(holder === any.id || holder === review.id);
  const { message } = await client().thread(task.id);
  assert.equal(message.task?.state, "claimed");
  assert.equal(message.labels["eve-claim-watch"], holder);

  await as("alice", "/messages", { re: task.id, text: "Check the burst limit too." });
  await wakeUntil(from, () => deliveries.length > 1);
  await wake(from, "none");

  assert.deepEqual(
    deliveries.slice(1).map((entry) => [entry.address, entry.message]),
    [[`${holder}:thread:${task.thread}`, "Check the burst limit too."]],
  );
});

const converse = { type: "converse" } as const;

test("a claim watch never takes a task in a channel `can` excludes", async () => {
  const { as } = await startBoard();
  const can = { "work/": ["read", "post", "react", "label"], "work/secret": [] } as const;
  await createWatch({
    action: { queue: { channel: "work/", from: ["vercel:user:alice"] }, type: "claim" },
    client: client(),
    id: "w-scope1",
    instructions: "Do the task.",
    tail: "work/",
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  const { deliveries, from } = recorder();
  const secret = (await as("alice", "/tasks", { channel: "work/secret", text: "Rotate the keys." }))
    .task;
  const open = (await as("alice", "/tasks", { channel: "work/public", text: "Fix the docs." }))
    .task;
  for (let pull = 0; pull < 6 && deliveries.length < 1; pull += 1) {
    await drainMatches({ from, settings: { ...settings(), can }, wait: 25 });
  }
  await drainMatches({ from, settings: { ...settings(), can } });

  assert.deepEqual(
    deliveries.map((entry) => entry.address),
    [`w-scope1:thread:${open.thread}`],
  );
  assert.equal((await client().thread(secret.id)).message.task?.state, "ready");
});

test("a profile with capital letters still runs its watches", async () => {
  const { as } = await startBoard();
  const upper = () => ({ profile: "Helper" });
  await runTool(
    defineBoardWatchTool(upper),
    { instructions: "Summarize it.", channel: "incidents" },
    { callId: "c1" },
  );
  const { deliveries, from } = recorder();
  await as("alice", "/messages", { channel: "incidents", text: "Down." });
  for (let pull = 0; pull < 6 && deliveries.length < 1; pull += 1) {
    await drainMatches({ from, settings: upper(), wait: 25 });
  }

  assert.deepEqual(
    deliveries.map((entry) => entry.message),
    ["Down."],
  );
  const listed = await runTool(defineBoardWatchesTool(upper), { details: true }, { callId: "c2" });
  assert.equal(listed.watches[0].instructions, "Summarize it.");
});

test("a match inside the watch channel never starts a turn", async () => {
  const { as } = await startBoard();
  await createWatch({
    action: converse,
    client: client(),
    id: "w-every1",
    instructions: "Read it.",
    tail: '""',
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  const { deliveries, from } = recorder();
  await as("alice", "/messages", { channel: DEFAULT_WATCH_CHANNEL, text: "A note about watches." });
  await as("alice", "/messages", { channel: "dev", text: "Shipped." });
  await wakeUntil(from, () => deliveries.length > 0);
  await wake(from, "none");

  assert.deepEqual(
    deliveries.map((entry) => entry.message),
    ["Shipped."],
  );
});

test("unwatch takes only a watch ID, and a retired record shows up as a problem", async () => {
  await startBoard();
  assert.equal(accepts(defineBoardUnwatchTool(settings), { id: "w-aaaaaa|w-bbbbbb" }), false);
  await assert.rejects(
    removeWatch({ client: client(), id: "w-aaaaaa|w-bbbbbb", watchChannel: DEFAULT_WATCH_CHANNEL }),
    /isn't a board watch ID/u,
  );
  await createWatch({
    action: converse,
    client: client(),
    id: "w-retire",
    instructions: "Summarize it.",
    tail: "incidents",
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  const record = await findWatchRecord({
    client: client(),
    id: "w-retire",
    self: await client().me(),
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  await client().label(record.message.id, { set: { "eve-watch-state": "retired" } });

  const [listed] = await listWatches({
    client: client(),
    details: true,
    watchChannel: DEFAULT_WATCH_CHANNEL,
  });
  assert.match(listed?.problem ?? "", /retired, so it never fires/u);
});

test("a watch the board refuses leaves its record retired, and a retry revives it", async () => {
  await startBoard();
  const create = (tail: string) =>
    createWatch({
      action: converse,
      client: client(),
      id: "w-retry1",
      instructions: "Summarize it.",
      tail,
      watchChannel: DEFAULT_WATCH_CHANNEL,
    });
  const recordState = async () =>
    (
      await findWatchRecord({
        client: client(),
        id: "w-retry1",
        self: await client().me(),
        watchChannel: DEFAULT_WATCH_CHANNEL,
      })
    ).retired;

  await assert.rejects(create("incidents --bogus"));
  assert.equal(await recordState(), true);
  await create("incidents");
  assert.equal(await recordState(), false);
  assert.deepEqual((await heldRegistration(client()))?.watch, {
    "w-retry1": { tail: "incidents" },
  });
});

test("watch instructions too long to store are refused before anything is written", async () => {
  const { calls } = await startBoard();
  assert.equal(
    accepts(defineBoardWatchTool(settings), {
      instructions: "x".repeat(BOARD_TEXT_LIMIT),
      tail: "incidents",
    }),
    false,
  );
  await assert.rejects(
    createWatch({
      action: converse,
      client: client(),
      id: "w-long01",
      instructions: "x".repeat(BOARD_TEXT_LIMIT),
      tail: "incidents",
      watchChannel: DEFAULT_WATCH_CHANNEL,
    }),
    /too long to store/u,
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("POST")),
    [],
  );
});

test("watch filters too long for the board are refused before anything is written", async () => {
  const { calls } = await startBoard();
  const label = Array.from({ length: 6 }, (_, index) => `${"k".repeat(180)}${index}=v`);

  await assert.rejects(
    runTool(
      defineBoardWatchTool(settings),
      { channel: "incidents", instructions: "Summarize it.", label },
      { callId: "c1" },
    ),
    /too long for the board: shorten them by \d+ characters/u,
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("POST")),
    [],
  );
});

test("a wake before any watch is registered drains nothing", async () => {
  await startBoard();
  const { deliveries, from } = recorder();

  assert.equal(await drainMatches({ from, settings: settings() }), 0);
  assert.deepEqual(deliveries, []);
});
