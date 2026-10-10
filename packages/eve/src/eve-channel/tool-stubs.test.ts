import { beforeEach, describe, expect, it, vi } from "vitest";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelInput } from "#eve-channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const storage = vi.hoisted(() => ({
  exists: vi.fn<() => Promise<boolean>>(),
  failure: vi.fn<() => Promise<string | undefined>>(),
  matched: vi.fn<() => Promise<readonly string[]>>(),
}));

vi.mock("#execution/tool-stubs/steps.js", () => ({
  readStubFailure: storage.failure,
  readMatchedStubRules: storage.matched,
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  getRun: () => ({
    get exists() {
      return storage.exists();
    },
  }),
}));

beforeEach(() => {
  storage.exists.mockReset().mockResolvedValue(true);
  storage.failure.mockReset().mockResolvedValue(undefined);
  storage.matched.mockReset().mockResolvedValue(["used"]);
});

const alice = {
  authenticator: "verified-token",
  issuer: "tests",
  principalId: "alice",
  principalType: "user",
  subject: "eval-a",
  attributes: { role: "eval" },
};
const bob = { ...alice, principalId: "bob", subject: "eval-b", attributes: { role: "user" } };

describe("tool stub authorization", () => {
  it("rejects authenticated callers without explicit override permission before session creation", async () => {
    const response = await request(
      { auth: () => alice },
      "POST",
      "/eve/v1/session",
      {},
      { stubs: [{ id: "auth", tool: "authenticate", outcome: { response: true } }] },
    );
    expect(response.status).toBe(403);
  });

  it("binds the grant to route authentication before onMessage projects the session principal", async () => {
    let scope: unknown;
    const response = await request(
      {
        auth: () => ({ ...alice, allowToolStubs: true }),
        onMessage: (ctx) => {
          expect(ctx.eve.caller).not.toHaveProperty("allowToolStubs");
          return { auth: bob };
        },
      },
      "POST",
      "/eve/v1/session",
      {},
      {
        message: "Hello",
        stubs: [{ id: "auth", tool: "authenticate", outcome: { response: true } }],
      },
      (input) => {
        expect(input.audienceAuth).not.toHaveProperty("allowToolStubs");
        scope = input.toolStubs;
        return { sessionId: "created" } as never;
      },
    );
    expect(response.status).toBe(202);
    expect(scope).toMatchObject({
      rules: [{ id: "auth", tool: "authenticate", outcome: { response: true } }],
    });
    expect(scope).toHaveProperty("token", expect.any(String));
  });

  it("does not accept permission supplied in a request body or projected by onMessage", async () => {
    const response = await request(
      { auth: () => bob, onMessage: () => ({ auth: { ...alice, allowToolStubs: true } }) },
      "POST",
      "/eve/v1/session",
      {},
      {
        allowToolStubs: true,
        stubs: [{ id: "auth", tool: "authenticate", outcome: { response: true } }],
      },
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["POST", "/eve/v1/session/:sessionId"],
    ["POST", "/eve/v1/session/:sessionId/compact"],
    ["POST", "/eve/v1/session/:sessionId/clear"],
    ["GET", "/eve/v1/session/:sessionId/stream"],
    ["GET", "/eve/v1/session/:sessionId/stubs"],
  ])("requires channel authentication for %s %s", async (method, path) => {
    const response = await request(
      { auth: () => null },
      method,
      path,
      { sessionId: "session", parentSessionId: "parent", childSessionId: "child", callId: "call" },
      { message: "Hello" },
    );
    expect(response.status).toBe(401);
  });
});

describe("tool stub verification", () => {
  it("requires the stub grant before reading any workflow", async () => {
    const response = await request(
      { auth: () => alice },
      "GET",
      "/eve/v1/session/:sessionId/stubs",
      { sessionId: "arbitrary-run" },
    );
    expect(response.status).toBe(403);
    expect(storage.exists).not.toHaveBeenCalled();
    expect(storage.failure).not.toHaveBeenCalled();
    expect(storage.matched).not.toHaveBeenCalled();
  });
  it("does not report success for a missing session", async () => {
    storage.exists.mockResolvedValue(false);
    const response = await request(
      { auth: () => ({ ...alice, allowToolStubs: true }) },
      "GET",
      "/eve/v1/session/:sessionId/stubs",
      { sessionId: "missing" },
    );
    expect(response.status).toBe(404);
  });

  it.each([undefined, "Stubbed tool output was invalid."])(
    "reports the recorded failure for an existing session: %s",
    async (failure) => {
      storage.failure.mockResolvedValue(failure);
      const response = await request(
        { auth: () => ({ ...alice, allowToolStubs: true }) },
        "GET",
        "/eve/v1/session/:sessionId/stubs",
        { sessionId: "session" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: failure ?? null, matchedRuleIds: ["used"] });
    },
  );

  it.each(["exists", "failure", "matched"] as const)(
    "returns a safe error when the %s read fails",
    async (operation) => {
      captureLogRecords();
      storage[operation].mockRejectedValue(new Error("private backend details"));
      const response = await request(
        { auth: () => ({ ...alice, allowToolStubs: true }) },
        "GET",
        "/eve/v1/session/:sessionId/stubs",
        { sessionId: "session" },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to verify tool stubs.",
        errorId: expect.any(String),
        ok: false,
      });
    },
  );
});

async function request(
  config: EveChannelInput,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
  create?: Parameters<typeof attachRouteSessionCreator>[1],
): Promise<Response> {
  const route = eveChannel(config).routes!.find(
    (route) => route.method === method && route.path === path,
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
      throw new Error("Unauthorized session access reached the runtime.");
    },
    to: () => {
      throw new Error("Unexpected remote dispatch.");
    },
  } satisfies RouteHandlerArgs;
  if (create !== undefined) attachRouteSessionCreator(args, create);
  return (await route.handler(
    new Request("https://agent.test" + path, {
      method,
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    args,
  )) as Response;
}
