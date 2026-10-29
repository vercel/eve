import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { none } from "#public/channels/auth.js";
import { eveChannel, type EveChannelConfig } from "#public/channels/eve.js";
import { defineCommand } from "#public/definitions/command.js";

const clear = defineCommand({
  description: "Clear the session context",
  session: "required",
  async run({ session }) {
    await session.clear();
    return { message: "Clearing the session context." };
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

describe("eve channel commands", () => {
  it("lists command metadata behind route auth", async () => {
    const commands = {
      clear,
      triage: { description: "Triage", argumentHint: "[label]", aliases: ["t"], run: vi.fn() },
    };
    const list = route("GET", "/eve/v1/commands", { auth: none(), commands });
    const response = await list(new Request("https://eve.test/eve/v1/commands"), args({}));
    expect(await response.json()).toEqual({
      ok: true,
      commands: [
        { name: "clear", description: "Clear the session context", session: "required" },
        {
          name: "triage",
          description: "Triage",
          argumentHint: "[label]",
          aliases: ["t"],
          session: "optional",
        },
      ],
    });

    const rejected = route("GET", "/eve/v1/commands", { auth: () => null, commands });
    expect((await rejected(new Request("https://eve.test/eve/v1/commands"), args({}))).status).toBe(
      401,
    );
  });

  it("runs a command with the trimmed argument and returns its result", async () => {
    const run = vi.fn().mockResolvedValue({ message: "Queued", send: "Triage bugs" });
    const response = await runCommand(
      { auth: none(), commands: { triage: { description: "Triage", aliases: ["t"], run } } },
      "t",
      { argument: "  bugs " },
    );
    expect(await response.json()).toEqual({ ok: true, message: "Queued", send: "Triage bugs" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ argument: "bugs" }));
  });

  it("runs a session command against the addressed session as the caller", async () => {
    const clearSession = vi.fn().mockResolvedValue({});
    const response = await route("POST", "/eve/v1/session/:sessionId/commands/:name", {
      auth: () => ({ principalId: "alice", principalType: "user" }) as never,
      commands: { clear },
    })(
      post("/eve/v1/session/wrun_A/commands/clear"),
      args({ sessionId: "wrun_A", name: "clear" }, { clear: clearSession }),
    );

    expect(await response.json()).toEqual({
      ok: true,
      message: "Clearing the session context.",
      controls: ["clear"],
    });
    expect(clearSession).toHaveBeenCalledWith({
      auth: expect.objectContaining({ principalId: "alice" }),
    });
  });

  it("refuses a session command outside a session", async () => {
    const response = await runCommand({ auth: none(), commands: { clear } }, "clear");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "/clear only works inside a conversation.",
    });
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
