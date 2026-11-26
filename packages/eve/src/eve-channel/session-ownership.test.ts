import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import { createAttachSessionFn } from "#channel/session.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { eveChannel } from "#eve-channel/index.js";
import type { EveAuthFn, EveAuthResult, EveSessionAccessPolicy } from "#eve-channel/types.js";
import { ForbiddenError } from "#public/channels/auth.js";
import { ANONYMOUS_SESSION_AUTH_CONTEXT } from "#channel/principal-identity.js";
import { sessionAuthFromResult } from "#channel/auth/result.js";
import { continueTurnAuth } from "#execution/session/principal.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import {
  EVE_DESCENDANT_STREAM_ROUTE_PATTERN,
  EVE_SESSION_CANCEL_ROUTE_PATTERN,
  EVE_SESSION_CLEAR_ROUTE_PATTERN,
  EVE_SESSION_COMPACT_ROUTE_PATTERN,
  EVE_SESSION_END_ROUTE_PATTERN,
  EVE_SESSION_RESET_ROUTE_PATTERN,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
  EVE_SESSION_STUBS_ROUTE_PATTERN,
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  getRun: () => ({ exists: Promise.resolve(true) }),
}));
vi.mock("#execution/tool-stubs/steps.js", () => ({
  readStubFailure: vi.fn().mockResolvedValue(undefined),
  readMatchedStubRules: vi.fn().mockResolvedValue([]),
}));

const principal = (workspace: string) =>
  ({
    allowToolStubs: true,
    attributes: {},
    authenticator: "workspace-token",
    principalId: `workspace:${workspace}`,
    principalType: "service",
  }) as const;
const wsA = principal("ws_a");
const wsB = principal("ws_b");

const wsC = principal("ws_c");
const workspaces = { ws_a: wsA, ws_b: wsB, ws_c: wsC } as const;
type Workspace = keyof typeof workspaces;

const identity = (request: Request) =>
  workspaces[(request.headers.get("x-workspace") ?? "ws_a") as Workspace];

const withAccess =
  (access: EveSessionAccessPolicy | undefined, base = identity): EveAuthFn =>
  (request): EveAuthResult => ({
    ...base(request),
    ...(access !== undefined && { sessionAccess: access }),
  });

const ownerAuth = withAccess("owner");

const dispatchedAuth = (h: ReturnType<typeof harness>) =>
  vi
    .mocked(h.runtime.dispatchSession)
    .mock.calls.map(([{ command }]) => ("auth" in command ? command.auth : undefined));

const closedStream = () => new ReadableStream({ start: (controller) => controller.close() });

function harness(recorded: Readonly<Record<string, SessionAuthContext | null>> = { wrun_A: wsA }) {
  const owners = new Map(
    Object.entries(recorded).map(([id, owner]) => [id, invocationOwnerKey(owner)]),
  );
  const runtime: Runtime = {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    resolveContinuation: vi.fn(),
    dispatchSession: vi.fn().mockResolvedValue({ status: "accepted" }),
    getEventStream: vi.fn().mockImplementation(async () => closedStream()),
    getLineStream: vi.fn().mockImplementation(async () => closedStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    hasRunnableOwner: vi.fn().mockResolvedValue(true),
    readChildBinding: vi.fn().mockResolvedValue(undefined),
    ownsSession: async (sessionId: string, caller: SessionAuthContext | null) =>
      owners.get(sessionId) === invocationOwnerKey(caller),
  };
  const args = (params: Record<string, string>): RouteHandlerArgs => ({
    ...mockAgentRouteArgs(),
    ...mockChannelContext(vi.fn()),
    attachSession: createAttachSessionFn(runtime),
    to: vi.fn() as never,
    params,
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  });
  return { args, runtime };
}

async function call(
  method: "GET" | "POST",
  pattern: string,
  workspace: Workspace,
  params: Record<string, string>,
  body: unknown,
  h: ReturnType<typeof harness>,
  authenticator: EveAuthFn = ownerAuth,
) {
  const found = eveChannel({ auth: authenticator }).routes.find(
    (route) => route.method === method && route.path === pattern,
  );
  if (found === undefined || !("handler" in found)) throw new Error(`Missing ${method} ${pattern}`);
  const path = pattern.replace(/:(\w+)/g, (_, name: string) => params[name] ?? "");
  const response = await found.handler(
    new Request(`https://eve.test${path}`, {
      method,
      headers: { "content-type": "application/json", "x-workspace": workspace },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    h.args(params),
  );
  return response as Response;
}

const owned = { sessionId: "wrun_A" };
const subagent = { parentSessionId: "wrun_A", callId: "call_1", childSessionId: "wrun_child" };

const routes = [
  ["prewarm", "POST", EVE_SESSION_ROUTE_PATTERN, owned, {}],
  ["message", "POST", EVE_SESSION_ROUTE_PATTERN, owned, { message: "hi" }],
  ["cancel", "POST", EVE_SESSION_CANCEL_ROUTE_PATTERN, owned, {}],
  ["compact", "POST", EVE_SESSION_COMPACT_ROUTE_PATTERN, owned, {}],
  ["clear", "POST", EVE_SESSION_CLEAR_ROUTE_PATTERN, owned, {}],
  ["end", "POST", EVE_SESSION_END_ROUTE_PATTERN, owned, {}],
  ["reset", "POST", EVE_SESSION_RESET_ROUTE_PATTERN, owned, {}],
  ["tool stubs", "GET", EVE_SESSION_STUBS_ROUTE_PATTERN, owned, undefined],
  ["stream", "GET", EVE_SESSION_STREAM_ROUTE_PATTERN, owned, undefined],
  ["descendant stream", "GET", EVE_DESCENDANT_STREAM_ROUTE_PATTERN, owned, undefined],
  ["subagent stream", "GET", EVE_SUBAGENT_STREAM_ROUTE_PATTERN, subagent, undefined],
] as const;

describe("eve session routes whose authenticator returns sessionAccess owner are scoped to the principal that created the session", () => {
  it.each(routes)(
    "answers %s with the unknown-session response for another principal and touches nothing",
    async (_name, method, pattern, params, body) => {
      const h = harness();
      const unknownParams = Object.fromEntries(
        Object.entries(params).map(([key, value]) => [
          key,
          key.endsWith("essionId") ? "wrun_none" : value,
        ]),
      );
      const unknown = await call(method, pattern, "ws_a", unknownParams, body, h);
      const foreign = await call(method, pattern, "ws_b", params, body, h);

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.json();
      await expect(foreign.json()).resolves.toEqual(unknownBody);
      expect(unknownBody).toEqual({
        error: "Session not found.",
        ok: false,
      });
      expect(h.runtime.dispatchSession).not.toHaveBeenCalled();
      expect(h.runtime.getEventStream).not.toHaveBeenCalled();
      expect(h.runtime.getLineStream).not.toHaveBeenCalled();
      expect(h.runtime.getStreamTailIndex).not.toHaveBeenCalled();
      expect(h.runtime.readChildBinding).not.toHaveBeenCalled();
    },
  );

  it.each(routes.filter(([name]) => name !== "subagent stream"))(
    "lets the creating principal use %s",
    async (_name, method, pattern, params, body) => {
      const h = harness();
      const response = await call(method, pattern, "ws_a", params, body, h);

      expect(response.status).not.toBe(404);
      expect(response.status).toBeLessThan(500);
    },
  );

  it("lets the creating principal look up a subagent stream's binding", async () => {
    const h = harness();
    await call("GET", EVE_SUBAGENT_STREAM_ROUTE_PATTERN, "ws_a", subagent, undefined, h);

    expect(h.runtime.readChildBinding).toHaveBeenCalledWith("wrun_A", "wrun_child");
  });

  it("denies a runtime that cannot say who owns a session", async () => {
    const h = harness();
    delete h.runtime.ownsSession;
    const response = await call(
      "GET",
      EVE_SESSION_STREAM_ROUTE_PATTERN,
      "ws_a",
      owned,
      undefined,
      h,
    );

    expect(response.status).toBe(404);
    expect(h.runtime.getLineStream).not.toHaveBeenCalled();
  });
});

describe("eve session routes with the default session access", () => {
  it.each(["omitted", "any"] as const)(
    "lets any authenticated principal reach any session when the authenticator returns sessionAccess %s",
    async (mode) => {
      const authenticator = withAccess(mode === "any" ? "any" : undefined);
      for (const [, method, pattern, params, body] of routes.filter(
        ([name]) => name !== "subagent stream",
      )) {
        const h = harness();
        const response = await call(method, pattern, "ws_b", params, body, h, authenticator);

        expect(response.status).not.toBe(404);
        expect(response.status).toBeLessThan(500);
      }
    },
  );

  it("does not ask the runtime who owns the session", async () => {
    const h = harness();
    const ownsSession = vi.fn().mockResolvedValue(false);
    h.runtime.ownsSession = ownsSession;
    const response = await call(
      "POST",
      EVE_SESSION_ROUTE_PATTERN,
      "ws_b",
      owned,
      { message: "hi" },
      h,
      withAccess(undefined),
    );

    expect(response.status).not.toBe(404);
    expect(ownsSession).not.toHaveBeenCalled();
  });
});

describe("eve session routes with sessionAccess owner and unusual creators", () => {
  const anonymousOwner: EveAuthFn = () => ({
    ...ANONYMOUS_SESSION_AUTH_CONTEXT,
    sessionAccess: "owner",
  });
  const customChannelAuth: SessionAuthContext = {
    attributes: {},
    authenticator: "custom-channel",
    principalId: "workspace:ws_a",
    principalType: "service",
  };

  it("lets an anonymous caller reach a session created with auth null", async () => {
    const h = harness({ wrun_A: null });
    const response = await call(
      "POST",
      EVE_SESSION_CANCEL_ROUTE_PATTERN,
      "ws_a",
      owned,
      {},
      h,
      anonymousOwner,
    );

    expect(response.status).not.toBe(404);
  });

  it("does not let an authenticated principal reach a session created with auth null", async () => {
    const h = harness({ wrun_A: null });
    const response = await call("POST", EVE_SESSION_CANCEL_ROUTE_PATTERN, "ws_a", owned, {}, h);

    expect(response.status).toBe(404);
    expect(h.runtime.dispatchSession).not.toHaveBeenCalled();
  });

  it("does not let an anonymous caller reach a session created by an authenticated principal", async () => {
    const h = harness();
    const response = await call(
      "POST",
      EVE_SESSION_CANCEL_ROUTE_PATTERN,
      "ws_a",
      owned,
      {},
      h,
      anonymousOwner,
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 when a custom channel created the session with a different identity tuple", async () => {
    const h = harness({ wrun_A: customChannelAuth });
    const response = await call("POST", EVE_SESSION_CANCEL_ROUTE_PATTERN, "ws_a", owned, {}, h);

    expect(response.status).toBe(404);
    expect(h.runtime.dispatchSession).not.toHaveBeenCalled();
  });

  it("lets the client resume a custom channel's session created with the eve channel's auth", async () => {
    const h = harness({ wrun_A: wsA });
    const response = await call("POST", EVE_SESSION_CANCEL_ROUTE_PATTERN, "ws_a", owned, {}, h);

    expect(response.status).not.toBe(404);
  });
});

describe("eve session routes with a sessionAccess chosen per caller", () => {
  const mixed: EveAuthFn = (request) =>
    request.headers.get("x-role") === "operator"
      ? { ...ANONYMOUS_SESSION_AUTH_CONTEXT, principalType: "service", sessionAccess: "any" }
      : ownerAuth(request);

  async function callAs(role: "tenant" | "operator", workspace: Workspace, h = harness()) {
    const found = eveChannel({ auth: mixed }).routes.find(
      (route) => route.method === "GET" && route.path === EVE_SESSION_STREAM_ROUTE_PATTERN,
    );
    if (found === undefined || !("handler" in found)) throw new Error("Missing stream route");
    return (await found.handler(
      new Request("https://eve.test/eve/v1/session/wrun_A/stream", {
        headers: { "x-role": role, "x-workspace": workspace },
      }),
      h.args(owned),
    )) as Response;
  }

  it("scopes tenant callers to their own sessions while operators on the same channel reach every session", async () => {
    const tenantOther = await callAs("tenant", "ws_b");
    const tenantOwner = await callAs("tenant", "ws_a");
    const operator = await callAs("operator", "ws_b");

    expect(tenantOther.status).toBe(404);
    expect(tenantOwner.status).toBe(200);
    expect(operator.status).toBe(200);
  });
});

describe("eve session routes with a custom sessionAccess predicate", () => {
  const collaboration = (): EveAuthFn => {
    const allowed = new Map([["ws_b", new Set(["wrun_A"])]]);
    return (request) => {
      const identityResult = identity(request);
      return {
        ...identityResult,
        sessionAccess: async ({ sessionId, isOwner }) =>
          (await isOwner()) ||
          allowed.get(request.headers.get("x-workspace") ?? "")?.has(sessionId) === true,
      };
    };
  };
  const stream = (workspace: Workspace, authenticator: EveAuthFn, h = harness()) =>
    call("GET", EVE_SESSION_STREAM_ROUTE_PATTERN, workspace, owned, undefined, h, authenticator);

  it("lets the owner and a granted collaborator in and answers 404 to everyone else", async () => {
    const authenticator = collaboration();

    expect((await stream("ws_a", authenticator)).status).toBe(200);
    expect((await stream("ws_b", authenticator)).status).toBe(200);
    expect((await stream("ws_c", authenticator)).status).toBe(404);
  });

  it("accepts a synchronous predicate", async () => {
    const authenticator = withAccess(({ sessionId }) => sessionId === "wrun_A");

    expect((await stream("ws_c", authenticator)).status).toBe(200);
    const other = await call(
      "GET",
      EVE_SESSION_STREAM_ROUTE_PATTERN,
      "ws_c",
      { sessionId: "wrun_Z" },
      undefined,
      harness(),
      authenticator,
    );
    expect(other.status).toBe(404);
  });

  it("does not ask the runtime who owns the session when the predicate decides without isOwner", async () => {
    const h = harness();
    const ownsSession = vi.fn().mockResolvedValue(false);
    h.runtime.ownsSession = ownsSession;

    const response = await stream(
      "ws_c",
      withAccess(() => true),
      h,
    );

    expect(response.status).toBe(200);
    expect(ownsSession).not.toHaveBeenCalled();
  });

  it("asks the runtime once per request however often the predicate calls isOwner", async () => {
    const h = harness();
    const ownsSession = vi.fn().mockResolvedValue(true);
    h.runtime.ownsSession = ownsSession;

    const response = await stream(
      "ws_a",
      withAccess(async ({ isOwner }) => (await isOwner()) && (await isOwner())),
      h,
    );

    expect(response.status).toBe(200);
    expect(ownsSession).toHaveBeenCalledOnce();
  });

  it("hands the predicate the session id, the caller identity without permissions, and the request", async () => {
    const predicate = vi.fn().mockReturnValue(true);

    await stream("ws_a", withAccess(predicate));

    expect(predicate).toHaveBeenCalledOnce();
    const context = predicate.mock.calls[0]![0];
    expect(context.sessionId).toBe("wrun_A");
    expect(context.auth).toEqual({
      attributes: {},
      authenticator: "workspace-token",
      principalId: "workspace:ws_a",
      principalType: "service",
    });
    expect(context.request).toBeInstanceOf(Request);
  });

  it("refuses with the HttpError the predicate throws", async () => {
    const response = await stream(
      "ws_a",
      withAccess(() => {
        throw new ForbiddenError({ message: "Collaboration is disabled." });
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Collaboration is disabled.",
      ok: false,
    });
  });

  it("fails closed without answering when the predicate throws another error", async () => {
    const h = harness();

    await expect(
      stream(
        "ws_a",
        withAccess(() => {
          throw new Error("directory unavailable");
        }),
        h,
      ),
    ).rejects.toThrow("directory unavailable");
    expect(h.runtime.getLineStream).not.toHaveBeenCalled();
  });

  it("checks the parent session id on the subagent stream route", async () => {
    const h = harness();
    const predicate = vi.fn().mockReturnValue(false);

    const response = await call(
      "GET",
      EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
      "ws_c",
      subagent,
      undefined,
      h,
      withAccess(predicate),
    );

    expect(response.status).toBe(404);
    expect(predicate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "wrun_A" }));
    expect(h.runtime.readChildBinding).not.toHaveBeenCalled();
  });

  it.each([["owner" as const], [async () => true]])(
    "never leaks sessionAccess into the identity a request dispatches with (%s)",
    async (access) => {
      const h = harness();

      await call(
        "POST",
        EVE_SESSION_CANCEL_ROUTE_PATTERN,
        "ws_a",
        owned,
        {},
        h,
        withAccess(access),
      );
      await call(
        "POST",
        EVE_SESSION_ROUTE_PATTERN,
        "ws_a",
        owned,
        { message: "hi" },
        h,
        withAccess(access),
      );

      const dispatched = dispatchedAuth(h);
      expect(dispatched).toHaveLength(2);
      for (const auth of dispatched) {
        expect(auth).toBeTruthy();
        expect(auth).not.toHaveProperty("sessionAccess");
        expect(auth).not.toHaveProperty("allowToolStubs");
      }
    },
  );

  it("dispatches a granted collaborator's message under the collaborator's own identity, which the running turn refuses to adopt", async () => {
    const h = harness();
    const response = await call(
      "POST",
      EVE_SESSION_ROUTE_PATTERN,
      "ws_b",
      owned,
      { message: "take over" },
      h,
      withAccess(() => true),
    );

    expect(response.status).toBeLessThan(300);
    const [auth] = dispatchedAuth(h);
    expect(auth).toMatchObject({ principalId: "workspace:ws_b" });
    expect(() => continueTurnAuth(sessionAuthFromResult(wsA), auth)).toThrow(
      "A message from another principal cannot join a running turn.",
    );
  });
});
