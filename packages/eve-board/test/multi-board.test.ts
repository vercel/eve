import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelFrom } from "eve/channels";

import extension from "../extension/extension.ts";
import {
  createBoardChannel,
  type BoardChannelContext,
  type BoardChannelState,
  type BoardReceiveTarget,
} from "../extension/lib/board-channel.ts";
import { formatConfiguredBoards } from "../extension/lib/boards.ts";
import { boardChannel } from "../extension/lib/channel.ts";
import { createBoardClient, type BoardSettings } from "../extension/lib/client.ts";
import {
  defineBoardActorsTool,
  defineBoardChannelsTool,
  defineBoardCreateTaskTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardReplyTool,
  defineBoardScheduleTool,
  defineBoardUnwatchTool,
  defineBoardWatchesTool,
  defineBoardWatchTool,
} from "../extension/lib/tools.ts";
import { registrationWhere } from "../extension/lib/watches.ts";
import { recorder, runTool, startBoards } from "./helpers.ts";

interface CompiledMultiBoardChannel {
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
    handler(
      request: Request,
      args: {
        from: ChannelFrom<BoardChannelState>;
        params: Readonly<Record<string, string>>;
        waitUntil(promise: Promise<unknown>): void;
      },
    ): Promise<Response>;
  }[];
  receive(
    input: { message: string; target: BoardReceiveTarget },
    ctx: { from: ChannelFrom<BoardChannelState> },
  ): Promise<unknown>;
  readonly adapter: {
    createAdapterContext(base: { state: BoardChannelState; session: unknown }): BoardChannelContext;
    fetchFile(url: string): Promise<{ bytes: Buffer; mediaType?: string } | null>;
    readonly instrumentation: { metadata(state: BoardChannelState): Record<string, unknown> };
  };
}

const compiledOf = (channel: unknown) => channel as CompiledMultiBoardChannel;

test("two boards wake independently on /eve/v1/board/:board/wake without touching the other board", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const config: BoardSettings = {
    boards: {
      a: { name: "alpha", url: a.url },
      b: { name: "beta", team: "acme-sec", url: b.url },
    },
    profile: "helper",
  };
  const settings = () => config;
  const created = await runTool(
    defineBoardWatchTool(settings),
    { board: "a", channel: "incidents", instructions: "Triage the incident." },
    { callId: "c1" },
  );
  assert.equal(created.board, "a");

  a.calls.length = 0;
  b.calls.length = 0;

  const posted = (await a.as("alice", "/messages", { channel: "incidents", text: "DB down." }))
    .message;
  const channel = compiledOf(createBoardChannel(settings));
  const namedWake = channel.routes.find((route) => route.path === "/eve/v1/board/:board/wake")!;
  const { deliveries, from } = recorder();
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => void pending.push(promise);

  for (let attempt = 0; attempt < 10 && deliveries.length === 0; attempt += 1) {
    pending.length = 0;
    const response = await namedWake.handler(
      new Request("https://agent.test/eve/v1/board/a/wake", { method: "POST" }),
      { from, params: { board: "a" }, waitUntil },
    );
    assert.equal(response.status, 202);
    await Promise.all(pending);
    if (deliveries.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery!.address, `a:${created.id}:thread:${posted.thread}`);
  assert.equal(delivery!.message, "DB down.");
  assert.equal(delivery!.options.state?.board, "a");
  assert.equal(delivery!.options.auth?.attributes.board, "a");
  assert.equal(delivery!.options.auth?.attributes.board_key, "a");
  assert.equal(delivery!.options.auth?.attributes.board_name, "alpha");
  assert.match(delivery!.options.idempotencyKey!, /^board:a:/u);
  assert.deepEqual(b.calls, []);
});

test("unknown keys, prototype keys, and unkeyed wakes return 404 and pull nothing", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const config: BoardSettings = {
    boards: {
      a: { name: "alpha", url: a.url },
      b: { name: "beta", url: b.url },
    },
    profile: "helper",
  };
  const channel = compiledOf(createBoardChannel(() => config));
  const namedWake = channel.routes.find((route) => route.path === "/eve/v1/board/:board/wake")!;
  const shorthandWake = channel.routes.find((route) => route.path === "/eve/v1/board/wake")!;
  const { from } = recorder();
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => void pending.push(promise);

  for (const badKey of ["unknown", "constructor", "toString", "__proto__"]) {
    const response = await namedWake.handler(
      new Request(`https://agent.test/eve/v1/board/${badKey}/wake`, { method: "POST" }),
      { from, params: { board: badKey }, waitUntil },
    );
    assert.equal(response.status, 404, badKey);
  }
  const unkeyed = await shorthandWake.handler(
    new Request("https://agent.test/eve/v1/board/wake", { method: "POST" }),
    { from, params: {}, waitUntil },
  );
  assert.equal(unkeyed.status, 404);
  assert.equal(pending.length, 0);
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, []);

  const shorthandChannel = compiledOf(createBoardChannel(() => ({ profile: "helper" })));
  const shorthandNamed = shorthandChannel.routes.find(
    (route) => route.path === "/eve/v1/board/:board/wake",
  )!;
  const shorthandBad = await shorthandNamed.handler(
    new Request("https://agent.test/eve/v1/board/default/wake", { method: "POST" }),
    { from, params: { board: "default" }, waitUntil },
  );
  assert.equal(shorthandBad.status, 404);
});

test("tools require `board` outside a board session when multiple boards exist, default to the session's board, and reject prototype keys", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const multi = (): BoardSettings => ({
    boards: {
      a: { can: { "infra/": ["read", "post"] }, name: "alpha", url: a.url },
      b: { name: "beta", url: b.url },
    },
    profile: "helper",
  });

  await assert.rejects(
    runTool(
      defineBoardWatchTool(multi),
      { channel: "incidents", instructions: "Summarize it." },
      { callId: "w1" },
    ),
    /Pass `board`.*Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(
      defineBoardWatchTool(multi),
      { board: "constructor", channel: "incidents", instructions: "Summarize it." },
      { callId: "w2" },
    ),
    /Unknown board "constructor".*Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardReadTool(multi), { channel: "dev" }, { callId: "r1" }),
    /Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardPostTool(multi), { channel: "dev", text: "Hi" }, { callId: "p1" }),
    /Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardChannelsTool(multi), {}, { callId: "ch1" }),
    /Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardActorsTool(multi), {}, { callId: "ac1" }),
    /Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardCreateTaskTool(multi), { channel: "work", text: "Do it" }, { callId: "t1" }),
    /Configured boards: a, b/u,
  );
  await assert.rejects(
    runTool(defineBoardUnwatchTool(multi), { id: "w-123456" }, { callId: "u1" }),
    /Configured boards: a, b/u,
  );

  await assert.rejects(
    runTool(
      defineBoardWatchTool(multi),
      { board: "a", channel: "incidents", instructions: "Summarize it." },
      { callId: "w3" },
    ),
    /may not read "incidents"/u,
  );
  const watchOnA = await runTool(
    defineBoardWatchTool(multi),
    { board: "a", channel: "infra/alerts", instructions: "Check infra." },
    { callId: "w4" },
  );
  const watchOnB = await runTool(
    defineBoardWatchTool(multi),
    { board: "b", channel: "incidents", instructions: "Check security." },
    { callId: "w5" },
  );

  const grouped = await runTool(defineBoardWatchesTool(multi), {}, { callId: "ls1" });
  assert.deepEqual(Object.keys(grouped.boards).sort(), ["a", "b"]);
  assert.deepEqual(
    grouped.boards.a.map((entry: { id: string }) => entry.id),
    [watchOnA.id],
  );
  assert.deepEqual(
    grouped.boards.b.map((entry: { id: string }) => entry.id),
    [watchOnB.id],
  );

  const singleExplicit = (): BoardSettings => ({
    boards: { a: { name: "alpha", url: a.url } },
    profile: "helper",
  });
  const watchSingle = await runTool(
    defineBoardWatchTool(singleExplicit),
    { channel: "dev", instructions: "Watch dev." },
    { callId: "w6" },
  );
  assert.equal(watchSingle.board, "a");
});

test("a reply, schedule, and attachment in a board B session stay on board B, and cross-board replies require an id", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const config: BoardSettings = {
    boards: {
      a: { name: "alpha", url: a.url },
      b: { name: "beta", url: b.url },
    },
    profile: "helper",
  };
  const settings = () => config;
  const rootB = await runTool(
    defineBoardPostTool(settings),
    { board: "b", channel: "sec", text: "Audit finding" },
    { callId: "p1" },
  );
  const sessionB = { board: "b", boardThread: rootB.id };

  const replied = await runTool(
    defineBoardReplyTool(settings),
    { text: "Investigating on B." },
    { callId: "r1", metadata: sessionB },
  );
  assert.equal(replied.re, rootB.id);

  const scheduled = await runTool(
    defineBoardScheduleTool(settings),
    { in: "5m", text: "Follow up on B." },
    { callId: "s1", metadata: sessionB },
  );
  assert.equal(scheduled.re, rootB.id);

  await assert.rejects(
    runTool(
      defineBoardReplyTool(settings),
      { board: "a", text: "Wrong board." },
      { callId: "r2", metadata: sessionB },
    ),
    /this session's thread is on board "b", not "a"/u,
  );

  const channel = compiledOf(createBoardChannel(settings));
  const stateB: BoardChannelState = {
    board: "b",
    channel: "sec",
    task: null,
    threadId: rootB.id,
  };
  const ctxB = channel.adapter.createAdapterContext({ session: { id: "s-b" }, state: stateB });
  await ctxB.board.reply("Final answer on B.");
  const metadataB = channel.adapter.instrumentation.metadata(stateB);
  assert.equal(metadataB.board, "b");

  const clientB = createBoardClient({ name: "beta", profile: "helper", url: b.url });
  const threadB = await clientB.thread(rootB.id);
  assert.deepEqual(
    threadB.replies.map((reply) => reply.text),
    ["Investigating on B.", "Final answer on B."],
  );
  const clientA = createBoardClient({ name: "alpha", profile: "helper", url: a.url });
  assert.deepEqual(await clientA.threads({ channel: "sec" }), []);

  const uploaded = await clientB.upload({
    data: new Uint8Array([1, 2, 3, 4]),
    name: "proof.bin",
    type: "application/octet-stream",
  });
  const fetched = await channel.adapter.fetchFile(`board-attachment:b/${uploaded.id}`);
  assert.deepEqual(fetched?.bytes, Buffer.from([1, 2, 3, 4]));
  assert.equal(await channel.adapter.fetchFile(`board-attachment:unknown/${uploaded.id}`), null);
});

test("to(boardChannel(), { board: 'b', ... }) starts a thread on board B and keeps route fingerprints matching", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const config: BoardSettings = {
    boards: {
      a: { name: "alpha", url: a.url },
      b: { name: "beta", url: b.url },
    },
    profile: "helper",
  };
  const mounted = compiledOf(createBoardChannel(() => config));
  const unbound = compiledOf(boardChannel());
  assert.deepEqual(
    mounted.routes.map((route) => `${route.method} ${route.path}`).sort(),
    unbound.routes.map((route) => `${route.method} ${route.path}`).sort(),
  );

  const { deliveries, from } = recorder();
  await assert.rejects(
    mounted.receive(
      { message: "Check status.", target: { channel: "sec", text: "Status" } },
      { from },
    ),
    /Pass `board`.*Configured boards: a, b/u,
  );

  await mounted.receive(
    { message: "Check status.", target: { board: "b", channel: "sec", text: "Status" } },
    { from },
  );

  const clientA = createBoardClient({ name: "alpha", profile: "helper", url: a.url });
  const clientB = createBoardClient({ name: "beta", profile: "helper", url: b.url });
  assert.deepEqual(await clientA.threads({ channel: "sec" }), []);
  const [summary] = await clientB.threads({ channel: "sec", limit: 1 });
  assert.equal(summary?.message.text, "Status");
  assert.deepEqual(
    deliveries.map((entry) => [entry.address, entry.options.state?.board]),
    [[`b:helper:thread:${summary?.message.thread}`, "b"]],
  );
});

test("per-board registration paths, async authorize, instructions, and schema validation work as specified", async () => {
  const { a, b } = await startBoards(["a", "b"] as const);
  const config: BoardSettings = {
    authorize: async ({ auth, board }) => {
      await Promise.resolve();
      return board === "a" && auth?.principalId === "vercel:user:alice";
    },
    boards: {
      a: { name: "alpha", url: a.url },
      b: {
        authorize: async ({ action, auth, boardName, team }) => {
          await Promise.resolve();
          assert.equal(boardName, "beta");
          assert.equal(team, "acme-sec");
          return action === "watches" && auth?.principalId === "vercel:user:bob";
        },
        name: "beta",
        team: "acme-sec",
        url: b.url,
      },
    },
    profile: "helper",
  };

  const watchesTool = defineBoardWatchesTool(() => config);
  const aliceList = await runTool(
    watchesTool,
    {},
    {
      auth: { attributes: {}, authenticator: "test", principalId: "vercel:user:alice" },
      callId: "l1",
    },
  );
  assert.deepEqual(Object.keys(aliceList.boards), ["a"]);
  const bobList = await runTool(
    watchesTool,
    {},
    {
      auth: { attributes: {}, authenticator: "test", principalId: "vercel:user:bob" },
      callId: "l1b",
    },
  );
  assert.deepEqual(Object.keys(bobList.boards), ["b"]);
  await assert.rejects(
    runTool(
      defineBoardWatchTool(() => config),
      { board: "b", channel: "incidents", instructions: "Summarize it." },
      {
        auth: { attributes: {}, authenticator: "test", principalId: "vercel:user:bob" },
        callId: "w-bob",
      },
    ),
    /not authorized to manage board watches/u,
  );
  await assert.rejects(
    runTool(
      watchesTool,
      {},
      {
        auth: { attributes: {}, authenticator: "test", principalId: "vercel:user:mallory" },
        callId: "l2",
      },
    ),
    /not authorized to manage board watches/u,
  );

  const env = { ...process.env };
  try {
    process.env.VERCEL_ENV = "production";
    process.env.EVE_PUBLIC_ROUTE_PREFIX = "/eve/support";
    assert.deepEqual(registrationWhere({ wake_by_path: true }, "/eve/v1/board/a"), {
      branch: null,
      path: "/eve/support/v1/board/a",
      url: null,
    });
  } finally {
    process.env = env;
  }

  assert.equal(formatConfiguredBoards({ profile: "helper" }), null);
  const rendered = formatConfiguredBoards(config);
  assert.ok(rendered !== null);
  assert.match(rendered, /`a`: alpha/u);
  assert.match(rendered, /`b`: beta \(team `acme-sec`\)/u);

  const parses = (input: unknown) =>
    (extension.schema as { safeParse(input: unknown): { success: boolean } }).safeParse(input)
      .success;
  assert.equal(
    parses({ boards: { infra: { name: "infra" }, sec: { name: "sec", team: "acme" } } }),
    true,
  );
  assert.equal(parses({ boards: {} }), false);
  assert.equal(parses({ boards: { infra: { name: "infra" } }, name: "top" }), false);
  assert.equal(parses({ boards: { a: { name: "same" }, b: { name: "same" } } }), false);
  assert.equal(parses({ boards: { "1bad": { name: "x" } } }), false);
});
