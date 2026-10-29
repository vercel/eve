import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { none } from "#public/channels/auth.js";
import { eveChannel, type EveChannelConfig } from "#public/channels/eve.js";
import { defineCommand } from "#public/definitions/command.js";

const existingRuns = new Set(["wrun_A"]);
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  getRun: (id: string) => ({ exists: Promise.resolve(existingRuns.has(id)) }),
}));

const ALICE = { principalId: "alice", principalType: "user" } as const;

const escalate = defineCommand({
  description: "Hand this conversation to a person",
  input: { hint: "[reason]" },
  aliases: ["human"],
  session: "required",
  async run({ argument, session }) {
    await session.cancel();
    return { message: "Escalated.", send: `Summarize this for support: ${argument}` };
  },
});

const restart = defineCommand({
  description: "Start over",
  session: "required",
  async run({ session }) {
    await session.end();
    return { message: "Started over." };
  },
});

function route(method: "GET" | "POST", path: string, input: EveChannelConfig) {
  const found = eveChannel(input).routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (found === undefined || !("handler" in found)) throw new Error(`Missing ${method} ${path}`);
  return found.handler as (request: Request, args: RouteHandlerArgs) => Promise<Response>;
}

function args(params: Record<string, string>, session?: Partial<Session>): RouteHandlerArgs {
  return {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(vi.fn()),
    attachSession: vi.fn(() => ({ id: params.sessionId, ...session })) as never,
    to: vi.fn() as never,
    params,
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  };
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://eve.test${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function runCommand(input: EveChannelConfig, name: string, body?: unknown) {
  return route(
    "POST",
    "/eve/v1/commands/:name",
    input,
  )(post(`/eve/v1/commands/${name}`, body), args({ name }));
}

function runSessionCommand(
  input: EveChannelConfig,
  sessionId: string,
  name: string,
  session: Partial<Session>,
  body?: unknown,
) {
  return route(
    "POST",
    "/eve/v1/session/:sessionId/commands/:name",
    input,
  )(
    post(`/eve/v1/session/${sessionId}/commands/${name}`, body),
    args({ sessionId, name }, session),
  );
}

describe("eve channel commands", () => {
  it("lists command metadata behind route auth", async () => {
    const commands = { escalate, restart };
    const list = route("GET", "/eve/v1/commands", { auth: none(), commands });
    const response = await list(new Request("https://eve.test/eve/v1/commands"), args({}));
    expect(await response.json()).toEqual({
      ok: true,
      commands: [
        {
          name: "escalate",
          description: "Hand this conversation to a person",
          input: { hint: "[reason]" },
          aliases: ["human"],
          session: "required",
        },
        { name: "restart", description: "Start over", session: "required" },
      ],
    });

    const rejected = route("GET", "/eve/v1/commands", { auth: () => null, commands });
    expect((await rejected(new Request("https://eve.test/eve/v1/commands"), args({}))).status).toBe(
      401,
    );
  });

  it("sends a command's follow-up into the session through onMessage, as the caller", async () => {
    const cancel = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue({ sessionId: "wrun_A", deliveryId: "d_1" });
    const onMessage = vi.fn<NonNullable<EveChannelConfig["onMessage"]>>((ctx) => ({
      auth: ctx.eve.caller,
      context: ["From /escalate."],
    }));
    const response = await runSessionCommand(
      { auth: () => ALICE as never, commands: { escalate }, onMessage },
      "wrun_A",
      "human",
      { cancel, send },
      { argument: "  refund failed " },
    );

    expect(await response.json()).toEqual({
      ok: true,
      message: "Escalated.",
      delivery: { sessionId: "wrun_A", deliveryId: "d_1" },
    });
    expect(cancel).toHaveBeenCalledWith({
      auth: expect.objectContaining({ principalId: "alice" }),
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ eve: expect.objectContaining({ sessionId: "wrun_A" }) }),
      "Summarize this for support: refund failed",
    );
    expect(send).toHaveBeenCalledWith(
      "Summarize this for support: refund failed",
      expect.objectContaining({
        auth: expect.objectContaining({ principalId: "alice" }),
        context: ["From /escalate."],
      }),
    );
  });

  it("reports when a command ended the session", async () => {
    const end = vi.fn().mockResolvedValue({});
    const response = await runSessionCommand(
      { auth: none(), commands: { restart } },
      "wrun_A",
      "restart",
      { end },
    );
    expect(await response.json()).toEqual({ ok: true, message: "Started over.", ended: true });
  });

  it("refuses a session it can't find before the command reads its id", async () => {
    const run = vi.fn();
    const response = await runSessionCommand(
      {
        auth: none(),
        commands: { peek: { description: "Peek", session: "required", run } },
      },
      "wrun_missing",
      "peek",
      {},
    );
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a session command outside a session, and text after a command without arguments", async () => {
    const outside = await runCommand({ auth: none(), commands: { restart } }, "restart");
    expect(outside.status).toBe(409);
    expect(await outside.json()).toMatchObject({
      error: "/restart only works inside a conversation.",
    });

    const extra = await runSessionCommand(
      { auth: none(), commands: { restart } },
      "wrun_A",
      "restart",
      { end: vi.fn() },
      { argument: "everything" },
    );
    expect(extra.status).toBe(400);
  });

  it("fails a session-free command that tries to send", async () => {
    const response = await runCommand(
      {
        auth: none(),
        commands: { nudge: { description: "Nudge", run: () => ({ send: "Hello." }) } },
      },
      "nudge",
    );
    expect(response.status).toBe(500);
  });

  it("rejects unknown commands, including inherited object keys", async () => {
    const config = { auth: none(), commands: {} };
    expect((await runCommand(config, "triage")).status).toBe(404);
    expect((await runCommand(config, "constructor")).status).toBe(404);
  });

  it("returns a generic error when a command throws", async () => {
    const response = await runCommand(
      {
        auth: none(),
        commands: {
          triage: {
            description: "Triage",
            run: () => {
              throw new Error("db password leaked");
            },
          },
        },
      },
      "triage",
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });

  it("rejects names a person cannot type, and names two commands share", () => {
    expect(() =>
      eveChannel({ auth: none(), commands: { "Open Issues": { description: "", run: vi.fn() } } }),
    ).toThrow(/Invalid eve channel command name "Open Issues"/u);
    expect(() =>
      eveChannel({
        auth: none(),
        commands: {
          new: { description: "", aliases: ["reset"], run: vi.fn() },
          reset: { description: "", run: vi.fn() },
        },
      }),
    ).toThrow(/"new" and "reset" both use the name "reset"/u);
  });
});
