import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";

const EVE_TOKEN = "deployment:prj_eve:production";

export interface TestBoardMessage {
  readonly id: string;
  readonly thread: string;
  readonly re: string | null;
  readonly task?: {
    readonly state: string;
    readonly claim: { readonly actor: string; readonly until: string } | null;
  };
}

export interface TestBoardCall {
  readonly method: string;
  readonly body: unknown;
  readonly response: unknown;
}

export interface TestBoard {
  readonly url: string;
  eveActor(profile?: string): string;
  beforePull(action: () => Promise<void>): void;
  onCall(record: (call: TestBoardCall) => void): void;
  post(
    person: string,
    body: {
      readonly channel?: string;
      readonly re?: string;
      readonly text: string;
      readonly labels?: Record<string, string>;
    },
  ): Promise<TestBoardMessage>;
  createTask(
    person: string,
    body: {
      readonly channel: string;
      readonly text: string;
      readonly labels?: Record<string, string>;
    },
  ): Promise<TestBoardMessage>;
  thread(id: string): Promise<{
    readonly message: TestBoardMessage;
    readonly replies: readonly (TestBoardMessage & {
      readonly text: string;
      readonly noSync: boolean;
    })[];
  }>;
  unblock(person: string, taskId: string): Promise<void>;
  dispose(): void;
}

const routes = new Map<string, (request: Request) => Promise<Response>>();
let restore: (() => void) | undefined;
let boards = 0;

function routeFetch(): void {
  if (restore !== undefined) return;
  const original = globalThis.fetch;
  const { BOARD_TOKEN, BOARD_URL } = process.env;
  restore = () => {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries({ BOARD_TOKEN, BOARD_URL })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restore = undefined;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    for (const [prefix, handler] of routes) {
      if (
        request.url === prefix ||
        request.url.startsWith(`${prefix}/`) ||
        request.url.startsWith(`${prefix}?`)
      ) {
        return await handler(request);
      }
    }
    return await original(input, init);
  }) as typeof globalThis.fetch;
}

function principalOf(token: string | undefined) {
  if (token === EVE_TOKEN) {
    return { handle: "eve", id: "vercel:project:prj_eve:production", kind: "deployment" as const };
  }
  const person = token?.startsWith("person:") ? token.slice("person:".length) : undefined;
  return person ? { handle: person, id: `vercel:user:${person}`, kind: "person" as const } : null;
}

export function disposeTestBoards(): void {
  routes.clear();
  restore?.();
}

export function createTestBoard(): TestBoard {
  boards += 1;
  const url = `https://board-${boards}.test/api/board`;
  const server = board({
    authenticate: ({ headers }) =>
      principalOf(headers.get("authorization")?.replace(/^Bearer /u, "")),
    backend: local({ memory: true }),
    url,
  });
  const pending: (() => Promise<void>)[] = [];
  const recorders: ((call: TestBoardCall) => void)[] = [];

  let ready: Promise<unknown> | undefined;

  routeFetch();
  routes.set(url, async (request) => {
    await ready;
    const path = new URL(request.url).pathname.slice(new URL(url).pathname.length) || "/";
    if (path === "/watchers/matches") for (const action of pending.splice(0)) await action();
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await server.fetch(request);
    if (recorders.length > 0) {
      const answered = response.clone();
      const call = {
        body: body === "" ? {} : (JSON.parse(body) as unknown),
        method: `${request.method} ${path}`,
        response: answered.headers.get("content-type")?.includes("json")
          ? ((await answered.json()) as unknown)
          : null,
      };
      for (const record of recorders) record(call);
    }
    return response;
  });
  process.env.BOARD_URL = url;
  process.env.BOARD_TOKEN = EVE_TOKEN;

  async function send<T>(person: string, path: string, body?: unknown): Promise<T> {
    const response = await server.fetch(
      new Request(`${url}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: `Bearer person:${person}`, "content-type": "application/json" },
        method: body === undefined ? "GET" : "POST",
      }),
    );
    if (!response.ok) throw new Error(`${path} as ${person} failed: ${await response.text()}`);
    return (await response.json()) as T;
  }

  ready = send("alice", "/grants", {
    can: { "*": "all" },
    principals: [{ environments: ["production"], kind: "project", project: "prj_eve" }],
  });
  const call = async <T>(person: string, path: string, body?: unknown): Promise<T> => {
    await ready;
    return await send<T>(person, path, body);
  };

  return {
    url,
    eveActor: (profile = "eve") => `vercel:project:prj_eve:production+${profile}`,
    beforePull: (action) => void pending.push(action),
    onCall: (record) => void recorders.push(record),
    post: async (person, body) =>
      (await call<{ message: TestBoardMessage }>(person, "/messages", body)).message,
    createTask: async (person, body) =>
      (await call<{ task: TestBoardMessage }>(person, "/tasks", body)).task,
    thread: (id) => call("alice", `/messages/${encodeURIComponent(id)}`),
    unblock: async (person, taskId) =>
      void (await call(person, `/tasks/${encodeURIComponent(taskId)}/unblock`, {})),
    dispose() {
      routes.delete(url);
      if (routes.size === 0) restore?.();
    },
  };
}
