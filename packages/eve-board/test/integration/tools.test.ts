import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";

import {
  defineBoardChannelsTool,
  defineBoardCompleteTaskTool,
  defineBoardCreateTaskTool,
  defineBoardLabelTool,
  defineBoardNoteTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardReleaseTaskTool,
  defineBoardReplyTool,
  defineBoardScheduleTool,
  defineBoardTypingTool,
} from "../../extension/lib/tools.ts";

const EVE_TOKEN = "deployment:prj_eve:production";
const realFetch = globalThis.fetch;
let boards = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOARD_URL;
  delete process.env.BOARD_TOKEN;
});

async function startBoard() {
  boards += 1;
  const url = `https://board-${boards}.test/api/board`;
  const team = board({
    authenticate: ({ headers }) => {
      const token = headers.get("authorization")?.replace(/^Bearer /u, "");
      if (token === EVE_TOKEN) {
        return { handle: "eve", id: "vercel:project:prj_eve:production", kind: "deployment" };
      }
      return token?.startsWith("person:")
        ? { handle: token.slice(7), id: `vercel:user:${token.slice(7)}`, kind: "person" }
        : null;
    },
    backend: local({ memory: true }),
    url,
  });
  const as = async (person: string, path: string, body?: unknown) => {
    const response = await team.fetch(
      new Request(`${url}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: `Bearer person:${person}`, "content-type": "application/json" },
        method: body === undefined ? "GET" : "POST",
      }),
    );
    assert.ok(response.ok, await response.clone().text());
    return (await response.json()) as Record<string, any>;
  };
  await as("alice", "/grants", {
    can: { "*": "all" },
    principals: [{ environments: ["production"], kind: "project", project: "prj_eve" }],
  });
  process.env.BOARD_URL = url;
  process.env.BOARD_TOKEN = EVE_TOKEN;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    return request.url.startsWith(url) ? await team.fetch(request) : await realFetch(request);
  };
  return { as };
}

type Executable = { execute(input: unknown, ctx: unknown): Promise<unknown> };
const settings = () => ({ profile: "helper" });
const files = new Map([["/workspace/after.png", new Uint8Array([137, 80, 78, 71])]]);
const run = (tool: unknown, input: unknown, callId: string, metadata: unknown = {}) =>
  (tool as Executable).execute(input, {
    abortSignal: new AbortController().signal,
    callId,
    channel: { kind: "channel:board__threads", metadata },
    getSandbox: async () => ({
      readBinaryFile: async ({ path }: { path: string }) => files.get(path) ?? null,
    }),
    session: { id: "session-1", auth: { current: null, initiator: null } },
  }) as Promise<Record<string, any>>;

test("the board tools post once per call, reply, label, and read back as the agent's profile", async () => {
  await startBoard();
  const post = defineBoardPostTool(settings);

  const root = await run(post, { channel: "dev", text: "Deploy checklist" }, "call-1");
  const retried = await run(post, { channel: "dev", text: "Deploy checklist" }, "call-1");
  assert.equal(retried.id, root.id);
  assert.equal(root.author, "eve/helper");

  await run(defineBoardReplyTool(settings), { id: root.id, text: "Migrations ran." }, "call-2");
  await run(defineBoardLabelTool(settings), { id: root.id, set: { status: "done" } }, "call-3");

  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "call-4");
  assert.deepEqual(thread.message.labels, { status: "done" });
  assert.deepEqual(
    thread.replies.map((reply: { text: string }) => reply.text),
    ["Migrations ran."],
  );

  const listed = await run(defineBoardReadTool(settings), { channel: "dev" }, "call-5");
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].replies, 1);

  const { channels } = await run(defineBoardChannelsTool(settings), {}, "call-6");
  assert.deepEqual(channels, [{ path: "dev" }]);
});

test("a reply attaches files from the sandbox and warns about mentions that notified no one", async () => {
  await startBoard();
  const root = await run(
    defineBoardPostTool(settings),
    { channel: "dev", text: "Fix the header" },
    "call-1",
  );
  const reply = defineBoardReplyTool(settings);

  const shot = await run(reply, { id: root.id, attach: ["/workspace/after.png"] }, "call-2");
  assert.deepEqual(shot.attachments, ["after.png"]);
  assert.equal(shot.warning, undefined);

  await assert.rejects(
    run(
      reply,
      { id: root.id, text: "and", attach: ["/workspace/after.png", "/nope.txt"] },
      "call-3",
    ),
    /There is no file at \/nope\.txt in the sandbox/u,
  );

  const mention = await run(reply, { id: root.id, text: "Done, @nobody" }, "call-4");
  assert.deepEqual(mention.unknownMentions, ["nobody"]);
  assert.match(mention.warning, /@nobody matched no one/u);

  assert.deepEqual(
    await run(defineBoardTypingTool(settings), { id: root.id, status: "Checking" }, "call-5"),
    { ok: true },
  );
  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "call-6");
  assert.equal(thread.replies.length, 2);
});

test("notes and schedules default to the session's own thread", async () => {
  await startBoard();
  const root = await run(defineBoardPostTool(settings), { channel: "dev", text: "Ship it" }, "c1");
  const session = { boardThread: root.id };

  const note = await run(
    defineBoardNoteTool(settings),
    { text: "Tried the cache." },
    "c2",
    session,
  );
  assert.equal(note.re, root.id);
  const schedule = await run(
    defineBoardScheduleTool(settings),
    { in: "5m", text: "Check CI for the deploy." },
    "c3",
    session,
  );
  assert.equal(schedule.thread, root.id);
  assert.ok(schedule.next);

  await assert.rejects(
    run(defineBoardNoteTool(settings), { text: "Nowhere." }, "c4"),
    /Pass the thread's `id`/u,
  );
});

test("task tools create a task and settle the claim the session holds", async () => {
  await startBoard();
  const created = await run(
    defineBoardCreateTaskTool(settings),
    { channel: "work/a", labels: { role: "review" }, text: "Review the limiter." },
    "c1",
  );
  assert.equal(created.task.state, "ready");

  const ready = (await (
    await globalThis.fetch(`${process.env.BOARD_URL}/tasks/${created.id}/claim`, {
      body: JSON.stringify({ lease: 60 }),
      headers: {
        authorization: `Bearer ${EVE_TOKEN}`,
        "content-type": "application/json",
        "x-board-profile": "helper",
      },
      method: "POST",
    })
  ).json()) as { claim: { epoch: number; token: string; until: string } };
  const held = { boardTask: { id: created.id, lease: 60, ...ready.claim } };

  assert.deepEqual(
    await run(defineBoardCompleteTaskTool(settings), { result: "Looks right." }, "c2", held),
    { settled: "completed", task: created.id },
  );
  const thread = await run(defineBoardReadTool(settings), { id: created.id }, "c3");
  assert.equal(thread.message.task.state, "completed");
  assert.equal(thread.message.task.result, "Looks right.");

  await assert.rejects(
    run(defineBoardReleaseTaskTool(settings), {}, "c4", held),
    /You no longer hold board task/u,
  );
  await assert.rejects(
    run(defineBoardCompleteTaskTool(settings), {}, "c5"),
    /This session holds no board task/u,
  );
});
