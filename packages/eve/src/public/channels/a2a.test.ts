import { AgentCard, Role } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { ForbiddenError, none, oauthResource, oidc, type AuthFn } from "#public/channels/auth.js";
import { a2aChannel } from "#public/channels/a2a.js";

const invocation = vi.hoisted(() => ({
  cancel: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
}));

vi.mock("#internal/invocation/workflow-execution.js", () => ({
  WorkflowAgentInvocationExecution: class {
    cancel = invocation.cancel;
    create = invocation.create;
    read = invocation.read;
    update = invocation.update;
  },
}));

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("a2aChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires auth and derives public security from none()", async () => {
    expect(() => a2aChannel({ security: { type: "public" } } as never)).toThrow(
      "a2aChannel requires auth. Use none() for explicit public access.",
    );
    expect(() => a2aChannel({ auth: () => principal })).toThrow(
      "a2aChannel requires security unless auth is oauthResource(oidc(...), ...).",
    );
    const channel = a2aChannel({ auth: none() });
    const response = await httpRoute(channel.routes[0]).handler(cardRequest(), routeArgs());
    await expect(response.json()).resolves.toMatchObject({
      securityRequirements: [],
      securitySchemes: {},
    });
  });

  it("publishes a discoverable A2A 1.0 Agent Card", async () => {
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/agent-card.json",
      "POST /eve/v1/a2a",
    ]);
    const route = httpRoute(channel.routes[0]);
    const first = await route.handler(cardRequest(), routeArgs());
    const card = await first.json();
    expect(() => AgentCard.fromJSON(card)).not.toThrow();
    expect(card).toMatchObject({
      capabilities: {
        extendedAgentCard: false,
        pushNotifications: false,
        streaming: false,
      },
      description: "Investigates tasks.",
      name: "compiled-agent",
      securityRequirements: [],
      securitySchemes: {},
      skills: [{ id: "agent", name: "compiled-agent" }],
      supportedInterfaces: [
        {
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          url: "https://agent.example/eve/v1/a2a",
        },
      ],
    });
    expect(first.headers.get("cache-control")).toBe("public, max-age=300");
    expect(first.headers.get("etag")).toMatch(/^".+"$/);

    const cached = await route.handler(
      cardRequest({ "if-none-match": first.headers.get("etag")! }),
      routeArgs(),
    );
    expect(cached.status).toBe(304);
  });

  it("validates authored security requirements", () => {
    expect(() =>
      a2aChannel({
        auth: () => principal,
        security: { requirements: [], schemes: {}, type: "authenticated" },
      }),
    ).toThrow("Authenticated A2A channels require at least one security scheme and requirement.");
    expect(() =>
      a2aChannel({
        auth: () => principal,
        security: {
          requirements: [{ schemes: { missing: { list: [] } } }],
          schemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
          type: "authenticated",
        },
      }),
    ).toThrow('A2A security requirement references unknown scheme "missing".');
  });

  it("derives and enforces Agent Card security from OAuth metadata", async () => {
    const issuer = "https://auth.example";
    const channel = a2aChannel({
      auth: oauthResource(oidc({ audiences: ["https://agent.example/eve/v1/a2a"], issuer }), {
        issuer,
        requiredScopes: ["a2a.invoke"],
        resource: "https://agent.example/eve/v1/a2a",
      }),
    });
    const response = await httpRoute(channel.routes[0]).handler(cardRequest(), routeArgs());
    await expect(response.json()).resolves.toMatchObject({
      securityRequirements: [{ schemes: { oidc: { list: ["a2a.invoke"] } } }],
      securitySchemes: {
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://auth.example/.well-known/openid-configuration",
          },
        },
      },
    });
  });

  it("publishes authored security requirements and card metadata", async () => {
    const channel = a2aChannel({
      auth: () => principal,
      card: {
        documentationUrl: "https://agent.example/docs",
        provider: { organization: "Acme", url: "https://acme.example" },
        skills: [
          {
            description: "Plans trips.",
            id: "travel",
            name: "Travel planning",
            tags: ["travel"],
          },
        ],
        version: "2.4.0",
      },
      security: {
        requirements: [{ schemes: { bearer: { list: ["a2a.invoke"] } } }],
        schemes: {
          bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
        },
        type: "authenticated",
      },
    });
    const response = await httpRoute(channel.routes[0]).handler(cardRequest(), routeArgs());
    await expect(response.json()).resolves.toMatchObject({
      documentationUrl: "https://agent.example/docs",
      provider: { organization: "Acme", url: "https://acme.example" },
      securityRequirements: [{ schemes: { bearer: { list: ["a2a.invoke"] } } }],
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
      },
      skills: [{ id: "travel" }],
      version: "2.4.0",
    });
  });

  it("interoperates with the official A2A JSON-RPC client", async () => {
    invocation.create.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "wrun_task",
      pollAfterMs: 1_000,
      status: "working",
    });
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const cardRoute = httpRoute(channel.routes[0]);
    const endpoint = httpRoute(channel.routes[1]);
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("host", new URL(request.url).host);
      if (new URL(request.url).pathname === "/.well-known/agent-card.json") {
        return await cardRoute.handler(request, routeArgs());
      }
      requestBody = await request.clone().json();
      return await endpoint.handler(request, routeArgs());
    };
    const client = await new ClientFactory({
      ...ClientFactoryOptions.default,
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    }).createFromUrl("https://agent.example");
    const result = await client.sendMessage({
      configuration: {
        acceptedOutputModes: [],
        returnImmediately: true,
        taskPushNotificationConfig: undefined,
      },
      message: {
        contextId: "",
        extensions: [],
        messageId: "message-1",
        metadata: undefined,
        parts: [
          {
            content: { $case: "text", value: "investigate" },
            filename: "",
            mediaType: "text/plain",
            metadata: undefined,
          },
        ],
        referenceTaskIds: [],
        role: Role.ROLE_USER,
        taskId: "",
      },
      metadata: undefined,
      tenant: "",
    });

    expect(requestBody).toMatchObject({ method: "SendMessage" });
    expect(result).toMatchObject({
      contextId: "wrun_task",
      id: "wrun_task",
      status: { state: 2 },
    });
  });

  it.each([
    { claim: undefined, label: "missing" },
    { claim: "profile calendar.read", label: "unrelated" },
  ])("rejects a verified token with $label scopes", async ({ claim }) => {
    const verifyToken: AuthFn<Request> = () => {
      const attributes: Record<string, string> = {};
      if (claim !== undefined) attributes.scope = claim;
      return { ...principal, attributes };
    };
    const requireScope: AuthFn<Request> = async (request) => {
      const auth = await verifyToken(request);
      if (auth == null) return null;
      const value = auth.attributes.scope;
      const scopes = typeof value === "string" ? value.split(/\s+/) : (value ?? []);
      if (!scopes.includes("a2a.invoke")) {
        throw new ForbiddenError({
          challenges: [
            {
              parameters: { error: "insufficient_scope", scope: "a2a.invoke" },
              scheme: "Bearer",
            },
          ],
        });
      }
      return auth;
    };
    const channel = a2aChannel({ auth: requireScope, security: authenticatedSecurity() });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: userMessage("work"),
      }),
      routeArgs(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="a2a.invoke"');
    expect(invocation.create).not.toHaveBeenCalled();
  });

  it("accepts a verified token containing the required scope", async () => {
    invocation.create.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "wrun_task",
      pollAfterMs: 1_000,
      status: "working",
    });
    const requireScope: AuthFn<Request> = () => ({
      ...principal,
      attributes: { scope: "profile a2a.invoke" },
    });
    const channel = a2aChannel({ auth: requireScope, security: authenticatedSecurity() });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: userMessage("work"),
      }),
      routeArgs(),
    );

    expect(response.status).toBe(200);
    expect(invocation.create).toHaveBeenCalledOnce();
  });

  it("authenticates requests before creating a task", async () => {
    const createSession = vi.fn();
    const channel = a2aChannel({
      auth: () => null,
      security: {
        requirements: [{ schemes: { bearer: { list: [] } } }],
        schemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
        type: "authenticated",
      },
    });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: userMessage("work"),
      }),
      routeArgs(createSession),
    );
    expect(response.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a durable task with SendMessage", async () => {
    invocation.create.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "wrun_task",
      pollAfterMs: 1_000,
      status: "working",
    });
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: userMessage("investigate"),
      }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      id: "request-1",
      jsonrpc: "2.0",
      result: {
        task: {
          contextId: "wrun_task",
          id: "wrun_task",
          status: { state: "TASK_STATE_WORKING" },
        },
      },
    });
    expect(invocation.create).toHaveBeenCalledWith({
      auth: expect.objectContaining({ authenticator: "none" }),
      message: "investigate",
    });
  });

  it("blocks by default until the task is interrupted", async () => {
    invocation.create.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "wrun_task",
      pollAfterMs: 1_000,
      status: "working",
    });
    invocation.read.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      inputRequests: {
        request: {
          action: { callId: "call", input: {}, kind: "tool-call", toolName: "ask_question" },
          kind: "question",
          prompt: "Which region?",
          requestId: "request",
        },
      },
      invocationId: "wrun_task",
      status: "input_required",
    });
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", { message: userMessage("investigate") }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { task: { status: { state: "TASK_STATE_INPUT_REQUIRED" } } },
    });
  });

  it("reads and cancels tasks with the authenticated principal", async () => {
    invocation.read
      .mockResolvedValueOnce({
        createdAt: "2026-09-05T00:00:00.000Z",
        invocationId: "wrun_task",
        pollAfterMs: 1_000,
        status: "working",
      })
      .mockResolvedValueOnce({
        createdAt: "2026-09-05T00:00:00.000Z",
        invocationId: "wrun_task",
        pollAfterMs: 1_000,
        status: "working",
      });
    invocation.cancel.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "wrun_task",
      status: "cancelled",
    });
    const channel = a2aChannel({ auth: () => principal, security: authenticatedSecurity() });
    const get = await httpRoute(channel.routes[1]).handler(
      rpcRequest("GetTask", { id: "wrun_task" }),
      routeArgs(),
    );
    await expect(get.json()).resolves.toMatchObject({
      result: { id: "wrun_task", status: { state: "TASK_STATE_WORKING" } },
    });
    expect(invocation.read).toHaveBeenNthCalledWith(1, {
      auth: principal,
      invocationId: "wrun_task",
    });

    const cancel = await httpRoute(channel.routes[1]).handler(
      rpcRequest("CancelTask", { id: "wrun_task" }),
      routeArgs(),
    );
    await expect(cancel.json()).resolves.toMatchObject({
      result: { status: { state: "TASK_STATE_CANCELED" } },
    });
    expect(invocation.cancel).toHaveBeenCalledWith({
      auth: principal,
      invocationId: "wrun_task",
    });
  });

  it("continues an input-required task with structured responses", async () => {
    invocation.read.mockResolvedValue({
      createdAt: "2026-09-05T00:00:00.000Z",
      inputRequests: {
        request: {
          action: { callId: "call", input: {}, kind: "tool-call", toolName: "ask_question" },
          kind: "question",
          prompt: "Which region?",
          requestId: "request",
        },
      },
      invocationId: "wrun_task",
      status: "input_required",
    });
    invocation.update.mockResolvedValue({
      invocation: {
        createdAt: "2026-09-05T00:00:00.000Z",
        invocationId: "wrun_task",
        pollAfterMs: 1_000,
        status: "working",
      },
      type: "success",
    });
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: {
          ...userMessage("ignored"),
          parts: [{ data: { responses: [{ requestId: "request", text: "us-east" }] } }],
          taskId: "wrun_task",
        },
      }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { task: { id: "wrun_task", status: { state: "TASK_STATE_WORKING" } } },
    });
    expect(invocation.update).toHaveBeenCalledWith({
      auth: expect.objectContaining({ authenticator: "none" }),
      invocationId: "wrun_task",
      responses: [{ requestId: "request", text: "us-east" }],
    });
  });

  it("rejects malformed send configuration and push setup", async () => {
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const malformed = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: "yes" },
        message: userMessage("work"),
      }),
      routeArgs(),
    );
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32602 } });

    const push = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: "https://client.example/hook" },
        },
        message: userMessage("work"),
      }),
      routeArgs(),
    );
    await expect(push.json()).resolves.toMatchObject({
      error: { code: -32003, data: [{ reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" }] },
    });
    expect(invocation.create).not.toHaveBeenCalled();
  });

  it("does not advertise unimplemented optional capabilities", async () => {
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendStreamingMessage", { message: userMessage("work") }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32004, data: [{ reason: "UNSUPPORTED_OPERATION" }] },
    });
  });

  it("returns TaskNotFound without leaking task ownership", async () => {
    invocation.read.mockResolvedValue(undefined);
    const channel = a2aChannel({ auth: () => principal, security: authenticatedSecurity() });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("GetTask", { id: "unknown-or-inaccessible" }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "a2a-protocol.org",
            reason: "TASK_NOT_FOUND",
          },
        ],
        message: "Task not found",
      },
    });
  });

  it("rejects raw parts before creating a task", async () => {
    const channel = a2aChannel({ auth: none(), security: { type: "public" } });
    const response = await httpRoute(channel.routes[1]).handler(
      rpcRequest("SendMessage", {
        configuration: { returnImmediately: true },
        message: {
          ...userMessage("ignored"),
          parts: [{ mediaType: "text/plain", raw: "c2VjcmV0" }],
        },
      }),
      routeArgs(),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32005, data: [{ reason: "CONTENT_TYPE_NOT_SUPPORTED" }] },
    });
    expect(invocation.create).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies and invalid browser origins before auth", async () => {
    const auth = vi.fn(() => principal);
    const channel = a2aChannel({ auth, security: authenticatedSecurity() });
    const oversized = rpcRequest("GetTask", { id: "task" });
    oversized.headers.set("content-length", String(1024 * 1024 + 1));
    const oversizedResponse = await httpRoute(channel.routes[1]).handler(oversized, routeArgs());
    await expect(oversizedResponse.json()).resolves.toMatchObject({
      error: { code: -32602, message: "Request body too large" },
    });

    const crossOrigin = rpcRequest("GetTask", { id: "task" });
    crossOrigin.headers.set("origin", "https://attacker.example");
    const originResponse = await httpRoute(channel.routes[1]).handler(crossOrigin, routeArgs());
    expect(originResponse.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
  });

  it("rejects unsupported protocol versions before auth", async () => {
    const auth = vi.fn(() => principal);
    const channel = a2aChannel({
      auth,
      security: {
        requirements: [{ schemes: { bearer: { list: [] } } }],
        schemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
        type: "authenticated",
      },
    });
    const request = rpcRequest("GetTask", { id: "missing" });
    request.headers.set("a2a-version", "0.3");
    const response = await httpRoute(channel.routes[1]).handler(request, routeArgs());
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32009, data: [{ reason: "VERSION_NOT_SUPPORTED" }] },
    });
    expect(auth).not.toHaveBeenCalled();
  });
});

function routeArgs(createSession: () => Promise<never> = vi.fn()): RouteHandlerArgs {
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const args: RouteHandlerArgs = {
    attachSession: unavailable,
    from: unavailable,
    params: {},
    requestIp: "127.0.0.1",
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  return attachAgentInfoRouteResponse(attachRouteSessionCreator(args, createSession), async () =>
    Response.json({
      agent: { description: "Investigates tasks.", name: "compiled-agent" },
    }),
  );
}

function cardRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/.well-known/agent-card.json", {
    headers: { host: "agent.example", ...headers },
  });
}

function authenticatedSecurity() {
  return {
    requirements: [{ schemes: { bearer: { list: [] } } }],
    schemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    type: "authenticated" as const,
  };
}

function rpcRequest(method: string, params: unknown): Request {
  return new Request("https://agent.example/eve/v1/a2a", {
    body: JSON.stringify({ id: "request-1", jsonrpc: "2.0", method, params }),
    headers: {
      "a2a-version": "1.0",
      "content-type": "application/json",
      host: "agent.example",
    },
    method: "POST",
  });
}

function userMessage(text: string) {
  return {
    messageId: "message-1",
    parts: [{ text }],
    role: "ROLE_USER",
  };
}

function httpRoute(route: ReturnType<typeof a2aChannel>["routes"][number] | undefined) {
  if (route === undefined || route.transport === "websocket") {
    throw new Error("Expected an HTTP route.");
  }
  return route;
}
