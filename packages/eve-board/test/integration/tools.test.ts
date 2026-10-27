import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { board } from "@vercel/board";
import { oidcTokens, vercelProject } from "@vercel/board/access";
import { a2 } from "@vercel/board/backend-a2";
import { memory } from "@vercel/board/backend-a2/store-memory";
import { generateKeyPair, SignJWT } from "jose";

import {
  defineBoardChannelsTool,
  defineBoardLabelTool,
  defineBoardPostTool,
  defineBoardReadTool,
  defineBoardReplyTool,
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
    backend: a2({ store: memory() }),
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
const run = (tool: unknown, input: unknown, callId: string) =>
  (tool as Executable).execute(input, {
    abortSignal: new AbortController().signal,
    callId,
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
    /set BOARD_URL, or pass `url` to the board extension/u,
  );
});
