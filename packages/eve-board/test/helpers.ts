import assert from "node:assert/strict";
import { afterEach } from "node:test";

import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";

const EVE_TOKEN = "deployment:prj_eve:production";
const realFetch = globalThis.fetch;
let boards = 0;

export const EVE_PRINCIPAL = "vercel:project:prj_eve:production";

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOARD_URL;
  delete process.env.BOARD_TOKEN;
});

export async function startBoard() {
  boards += 1;
  const url = `https://board-${boards}.test/api/board`;
  const team = board({
    authenticate: ({ headers }) => {
      const token = headers.get("authorization")?.replace(/^Bearer /u, "");
      if (token === EVE_TOKEN) {
        return { handle: "eve", id: EVE_PRINCIPAL, kind: "deployment" };
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
  const calls: string[] = [];
  process.env.BOARD_URL = url;
  process.env.BOARD_TOKEN = EVE_TOKEN;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(url)) return await realFetch(request);
    calls.push(
      `${request.method} ${new URL(request.url).pathname.slice(new URL(url).pathname.length)}`,
    );
    return await team.fetch(request);
  };
  return { as, calls };
}

export type Executable = { execute(input: unknown, ctx: unknown): Promise<unknown> };

export function runTool(
  tool: unknown,
  input: unknown,
  options: {
    readonly callId: string;
    readonly sessionId?: string;
    readonly metadata?: unknown;
    readonly auth?: unknown;
    readonly files?: ReadonlyMap<string, Uint8Array>;
  },
) {
  return (tool as Executable).execute(input, {
    abortSignal: new AbortController().signal,
    callId: options.callId,
    channel: { kind: "channel:board__board", metadata: options.metadata ?? {} },
    getSandbox: async () => ({
      readBinaryFile: async ({ path }: { path: string }) => options.files?.get(path) ?? null,
    }),
    session: {
      auth: { current: options.auth ?? null, initiator: null },
      id: options.sessionId ?? "session-1",
    },
  }) as Promise<Record<string, any>>;
}
