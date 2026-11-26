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

interface BoardOptions {
  readonly clientIdTaken?: boolean;
  readonly leaseCap?: number;
}

export async function startBoards<const TKey extends string>(
  keys: readonly TKey[],
  options: BoardOptions = {},
): Promise<
  Record<
    TKey,
    {
      readonly as: (person: string, path: string, body?: unknown) => Promise<Record<string, any>>;
      readonly calls: string[];
      readonly url: string;
    }
  >
> {
  const registry = new Map<
    string,
    {
      readonly calls: string[];
      readonly clientIds: Map<string, string>;
      readonly team: ReturnType<typeof board>;
      readonly url: string;
    }
  >();
  const result = {} as Record<
    TKey,
    {
      readonly as: (person: string, path: string, body?: unknown) => Promise<Record<string, any>>;
      readonly calls: string[];
      readonly url: string;
    }
  >;
  for (const key of keys) {
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
    registry.set(url, { calls, clientIds: new Map(), team, url });
    result[key] = { as, calls, url };
  }

  delete process.env.BOARD_URL;
  process.env.BOARD_TOKEN = EVE_TOKEN;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    for (const [url, entry] of registry) {
      if (!request.url.startsWith(url)) continue;
      const path = new URL(request.url).pathname.slice(new URL(url).pathname.length);
      entry.calls.push(`${request.method} ${path}`);
      const taken =
        options.clientIdTaken === true && (await clientIdTaken(entry.clientIds, request, path));
      if (taken) return taken;
      if (options.leaseCap === undefined || !/^\/tasks\/(?:claim|[^/]+\/renew)$/u.test(path)) {
        return await entry.team.fetch(request);
      }
      const body = (await request.json()) as { lease?: number };
      const lease = Math.min(body.lease ?? options.leaseCap, options.leaseCap);
      return await entry.team.fetch(
        new Request(request.url, {
          body: JSON.stringify({ ...body, lease }),
          headers: request.headers,
          method: request.method,
        }),
      );
    }
    return await realFetch(request);
  };
  return result;
}

async function clientIdTaken(
  seen: Map<string, string>,
  request: Request,
  path: string,
): Promise<Response | undefined> {
  if (request.method !== "POST" || path !== "/tasks") return undefined;
  const body = (await request.clone().json()) as { channel?: string; id?: string };
  if (body.id === undefined || body.channel === undefined) return undefined;
  const key = `${request.headers.get("authorization")} ${body.id}`;
  const channel = seen.get(key);
  if (channel === undefined) {
    seen.set(key, body.channel);
    return undefined;
  }
  if (channel === body.channel) return undefined;
  return Response.json(
    {
      error: {
        code: "client_id_taken",
        message: "This client ID names another of your posts, somewhere else.",
      },
    },
    { status: 409 },
  );
}

export async function startBoard(options: BoardOptions = {}) {
  const { default: instance } = await startBoards(["default"] as const, options);
  process.env.BOARD_URL = instance.url;
  return { as: instance.as, calls: instance.calls };
}

export type Executable = { execute(input: unknown, ctx: unknown): Promise<unknown> };

const PERSON_AUTH = {
  attributes: {},
  authenticator: "test",
  principalId: "vercel:user:alice",
  principalType: "user",
};

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
      auth: { current: options.auth === undefined ? PERSON_AUTH : options.auth, initiator: null },
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
