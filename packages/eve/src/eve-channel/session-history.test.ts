import { describe, expect, it, vi } from "vitest";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import {
  attachRouteSessionCreator,
  type RouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";

const runner = {
  authenticator: "verified-token",
  issuer: "tests",
  principalId: "eval-runner",
  principalType: "service",
  subject: "eval-runner",
  attributes: {},
};
const granted = { ...runner, allowHistoryImport: true };

const history = [
  { role: "user", text: "How do I redirect www.example.com to example.com?" },
  { id: "reply-1", role: "assistant", text: "Add both domains, then configure the redirect." },
];

describe("session history import authorization", () => {
  it.each([
    ["omitted", runner],
    ["false", { ...runner, allowHistoryImport: false }],
    ["granted only for tool stubs", { ...runner, allowToolStubs: true }],
  ] as const)("rejects history when the grant is %s", async (_case, identity) => {
    const { createSession, response } = await create({ auth: () => identity }, { history });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error:
        "Session history import is not permitted for this caller. The channel's auth must grant allowHistoryImport.",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not accept a grant supplied in the request body or projected by onMessage", async () => {
    const { createSession, response } = await create(
      { auth: () => runner, onMessage: () => ({ auth: granted }) },
      { allowHistoryImport: true, history, message: "Can we submit a case anyway?" },
    );

    expect(response.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects history on a follow-up message, even from a granted caller", async () => {
    const response = await request(
      { auth: () => granted },
      "/eve/v1/session/:sessionId",
      { sessionId: "session" },
      { history, message: "Can we submit a case anyway?" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unknown field 'history'."),
    });
  });
});

describe("session history import", () => {
  it("starts a message-free session from the supplied history without the grant on its identity", async () => {
    const { createSession, response } = await create({ auth: () => granted }, { history });

    expect(response.status).toBe(202);
    expect(createSession).toHaveBeenCalledTimes(1);
    const input = createSession.mock.calls[0]![0];
    expect(input.input).toEqual({ history });
    expect(input.auth).toEqual(runner);
    expect(input.audienceAuth).toEqual(runner);
  });

  it("starts a session from history with completed tool calls", async () => {
    const withCalls = [
      history[0],
      {
        role: "assistant",
        text: "Add both domains, then configure the redirect.",
        toolCalls: [
          { name: "search_docs", input: { query: "domain redirect" }, output: "Redirects…" },
          { name: "list_domains", error: "Timed out" },
        ],
      },
    ];
    const { createSession, response } = await create(
      { auth: () => granted },
      { history: withCalls },
    );

    expect(response.status).toBe(202);
    expect(createSession.mock.calls[0]![0].input).toEqual({ history: withCalls });
  });

  it("places the supplied history before the history onMessage resolves for the first message", async () => {
    const stored = [{ role: "user" as const, text: "Bob: the redirect is live." }];
    const { createSession, response } = await create(
      { auth: () => granted, onMessage: (ctx) => ({ auth: ctx.eve.caller, history: stored }) },
      { history, message: "Can we submit a case anyway?" },
    );

    expect(response.status).toBe(202);
    expect(createSession.mock.calls[0]![0].input).toMatchObject({
      history: [...history, ...stored],
      message: "Can we submit a case anyway?",
    });
  });

  it.each([
    ["a non-array", { role: "user", text: "Hi" }, "history must be an array of messages."],
    [
      "an unsupported role",
      [{ role: "system", text: "You are terse." }],
      'history[0].role must be "user" or "assistant".',
    ],
    ["empty text", [{ role: "user", text: " " }], "history[0].text must be a non-empty string."],
    [
      "a file",
      [...history, { role: "user", text: "See the report.", files: ["report.pdf"] }],
      'history[2] has unknown field "files". Accepted fields: id, role, text, toolCalls.',
    ],
    [
      "a tool call without a result",
      [...history, { role: "assistant", text: "Checking.", toolCalls: [{ name: "lookup" }] }],
      "history[2].toolCalls[0] must have exactly one of output or error.",
    ],
    [
      "a repeated id",
      [
        { id: "m1", role: "user", text: "Hi" },
        { id: "m1", role: "assistant", text: "Hello" },
      ],
      'history[1].id "m1" is not unique.',
    ],
  ])("rejects %s without creating a session", async (_case, malformed, error) => {
    const { createSession, response } = await create(
      { auth: () => granted },
      { history: malformed },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error });
    expect(createSession).not.toHaveBeenCalled();
  });
});

async function create(config: EveChannelConfig, body: unknown) {
  const createSession = vi.fn<RouteSessionCreator>(async () => ({ sessionId: "created" }) as never);
  const response = await request(config, "/eve/v1/session", {}, body, createSession);
  return { createSession, response };
}

async function request(
  config: EveChannelConfig,
  path: string,
  params: Record<string, string>,
  body: unknown,
  createSession?: RouteSessionCreator,
): Promise<Response> {
  const route = eveChannel(config).routes!.find(
    (route) => route.method === "POST" && route.path === path,
  )!;
  const args = {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(() => {
      throw new Error("Unexpected channel dispatch.");
    }),
    params,
    waitUntil: () => undefined,
    requestIp: "127.0.0.1",
    attachSession: () => {
      throw new Error("A rejected request reached the runtime.");
    },
    to: () => {
      throw new Error("Unexpected remote dispatch.");
    },
  } satisfies RouteHandlerArgs;
  if (createSession !== undefined) attachRouteSessionCreator(args, createSession);
  return (await route.handler(
    new Request("https://agent.test" + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    args,
  )) as Response;
}
