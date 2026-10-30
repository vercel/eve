import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { board } from "@vercel/board";
import { oidcTokens, vercelProject } from "@vercel/board/access";
import { a2, memoryBlob } from "@vercel/board/backend-a2";
import { memory } from "@vercel/board/backend-a2/store-memory";
import { generateKeyPair, SignJWT } from "jose";

import {
  defineBoardChannelsTool,
  defineBoardLabelTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardReplyTool,
  defineBoardTypingTool,
} from "../../extension/lib/tools.ts";

const URL_ = "https://board.example.com/api/board";
const ISSUER = "https://oidc.vercel.com/acme";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOARD_TOKEN;
});

/** A real board in memory that lets the `prj_eve` project's production deployment do everything. */
async function startBoard() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const team = board({
    access: [vercelProject({ can: "all", environments: ["production"], project: "prj_eve" })],
    authenticate: oidcTokens({ vercel: { issuer: ISSUER, jwks: async () => publicKey } }),
    backend: a2({ blob: memoryBlob(), store: memory() }),
    project: { id: "prj_board" },
    url: URL_,
  });
  process.env.BOARD_TOKEN = await new SignJWT({
    environment: "production",
    project: "eve",
    project_id: "prj_eve",
    sub: "owner:acme:project:eve:environment:production",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience(URL_)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    return request.url.startsWith(URL_) ? await team.fetch(request) : await realFetch(request);
  };
}

type Executable = { execute(input: unknown, ctx: unknown): Promise<unknown> };
const settings = () => ({ url: URL_, profile: "helper" });
const files = new Map([["/workspace/after.png", new Uint8Array([137, 80, 78, 71])]]);
const run = (tool: unknown, input: unknown, callId: string) =>
  (tool as Executable).execute(input, {
    abortSignal: new AbortController().signal,
    callId,
    getSandbox: async () => ({
      readBinaryFile: async ({ path }: { path: string }) => files.get(path) ?? null,
    }),
    session: { id: "session-1", auth: { current: null, initiator: null } },
  }) as Promise<Record<string, any>>;

test("the board tools post once per call, reply, label, and read back as the agent's profile", async () => {
  await startBoard();
  const post = defineBoardPostTool(settings);

  const root = await run(post, { channel: "dev", text: "Deploy checklist" }, "call-1");
  // A retried call carries the same call ID, so it lands once.
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
  assert.deepEqual(
    channels.map((channel: { path: string; threads: number }) => [channel.path, channel.threads]),
    [["dev", 1]],
  );
});

test("the board tools explain a missing board URL", async () => {
  delete process.env.BOARD_URL;
  await assert.rejects(
    run(
      defineBoardChannelsTool(() => ({})),
      {},
      "call-1",
    ),
    /set BOARD_URL, or pass `url` to the board channel or extension/u,
  );
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

  // A bad path uploads nothing and posts nothing.
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
    {
      ok: true,
    },
  );
  const thread = await run(defineBoardReadTool(settings), { id: root.id }, "call-6");
  assert.equal(thread.replies.length, 2);
});
