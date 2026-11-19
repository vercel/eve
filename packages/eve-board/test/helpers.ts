import assert from "node:assert/strict";
import { afterEach } from "node:test";

import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import type { ChannelFrom, ChannelSendOptions } from "eve/channels";

import type { BoardChannelState } from "../extension/lib/board-channel.ts";

const EVE_TOKEN = "deployment:prj_eve:production";
const realFetch = globalThis.fetch;
let boards = 0;

export const EVE_PRINCIPAL = "vercel:project:prj_eve:production";

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BOARD_URL;
  delete process.env.BOARD_TOKEN;
});

export async function startBoard(options: { readonly leaseCap?: number } = {}) {
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
    const path = new URL(request.url).pathname.slice(new URL(url).pathname.length);
    calls.push(`${request.method} ${path}`);
    if (options.leaseCap === undefined || !/^\/tasks\/(?:claim|[^/]+\/renew)$/u.test(path)) {
      return await team.fetch(request);
    }
    const body = (await request.json()) as { lease?: number };
    const lease = Math.min(body.lease ?? options.leaseCap, options.leaseCap);
    return await team.fetch(
      new Request(request.url, {
        body: JSON.stringify({ ...body, lease }),
        headers: request.headers,
        method: request.method,
      }),
    );
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

export interface Delivery {
  readonly address: string;
  readonly message: unknown;
  readonly options: ChannelSendOptions<BoardChannelState>;
}

export function fakeFrom(
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

export function recorder() {
  const deliveries: Delivery[] = [];
  const from = fakeFrom((address, message, options) => {
    deliveries.push({ address, message, options });
  });
  return { deliveries, from };
}

export function accepts(tool: unknown, input: unknown): boolean {
  const schema = (tool as { inputSchema: { safeParse(input: unknown): { success: boolean } } })
    .inputSchema;
  return schema.safeParse(input).success;
}
