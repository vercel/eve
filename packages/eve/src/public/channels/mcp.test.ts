import { describe, expect, it, vi } from "vitest";

import { deriveToolSessionId } from "#execution/tool-session/id.js";
import type { AgentDescription, AgentToolDescription } from "#channel/agent-description.js";
import type { InvokeToolFn, InvokeToolResult } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SkillFileSource } from "#channel/skill-files.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteChannelName,
  attachRouteSessionCreator,
  attachSkillFileSource,
} from "#internal/nitro/routes/channel-route-context.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { ForbiddenError, none, oauthResource, withAuthChallenges } from "#public/channels/auth.js";
import { mcpChannel, type McpChannelInput } from "#public/channels/mcp.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";

const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("mcpChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpChannel({} as never)).toThrow(
      "mcpChannel requires auth. Use none() for explicit public access.",
    );
  });

  it("publishes task-mode durable invocation compatibility tools", async () => {
    const channel = mcpChannel({ auth: none() });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /eve/v1/mcp",
      "POST /eve/v1/mcp",
      "DELETE /eve/v1/mcp",
    ]);
    const postRoute = channel.routes[1]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");

    const initialize = await postRoute.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    await expect(jsonRpcResponse(initialize)).resolves.toMatchObject({
      result: {
        instructions: expect.stringContaining("pollAfterMs"),
        serverInfo: { name: "compiled-agent" },
      },
    });

    const discovered = await postRoute.handler(
      mcpRequest(
        {
          id: "discover",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        },
        { "mcp-method": "server/discover", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      ),
      routeArgs(),
    );
    const discovery = (await jsonRpcResponse(discovered)) as {
      result: { instructions: string };
    };
    expect(discovery.result.instructions).toContain("agent_start is not idempotent");
    expect(discovery.result.instructions).toContain("ask the user before starting again");
    expect(discovery.result.instructions).toContain("agent_cancel");
    expect(discovery.result.instructions.length).toBeLessThan(800);

    const tools = await postRoute.handler(
      mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      routeArgs(),
    );
    const body = (await jsonRpcResponse(tools)) as {
      result: {
        tools: Array<{
          description?: string;
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema?: Record<string, unknown>;
        }>;
      };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "agent_start",
      "agent_get",
      "agent_update",
      "agent_cancel",
    ]);
    expect(body.result.tools[0]).toMatchObject({
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
      description: expect.stringContaining("Investigates tasks."),
      outputSchema: { type: "object" },
    });
    expect(body.result.tools[0]?.description).toContain("Not idempotent");
    expect(body.result.tools[1]).toMatchObject({
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: expect.stringContaining("pollAfterMs"),
    });
    expect(body.result.tools[2]?.description).toContain("partial batches are rejected");
    expect(body.result.tools[3]?.description).toContain("until status is terminal");
    expect(body.result.tools[3]?.description).not.toContain("until status is cancelled");
    expect(body.result.tools[2]).toMatchObject({
      annotations: {
        idempotentHint: false,
      },
      inputSchema: {
        properties: {
          responses: {
            items: {
              properties: {
                optionId: { type: "string" },
                requestId: { type: "string" },
                text: { type: "string" },
              },
              required: ["requestId"],
            },
          },
        },
      },
      outputSchema: {
        oneOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              inputRequests: expect.any(Object),
              status: { const: "input_required", type: "string" },
            }),
            required: expect.arrayContaining(["inputRequests"]),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              authorizations: expect.objectContaining({ minItems: 1 }),
              status: { const: "authorization_required", type: "string" },
            }),
            required: expect.arrayContaining(["authorizations"]),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              error: expect.any(Object),
              status: { const: "failed", type: "string" },
            }),
            required: expect.arrayContaining(["error"]),
          }),
        ]),
      },
    });
  });

  it("uses existing eve auth strategies directly", async () => {
    const channel = mcpChannel({ auth: () => principal });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    expect(response.status).toBe(200);
  });

  it("rejects cross-origin requests before running auth", async () => {
    const authenticate = vi.fn(() => principal);
    const channel = mcpChannel({ auth: authenticate });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest(
        {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
        },
        { origin: "https://attacker.example" },
      ),
      routeArgs(),
    );

    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 messages and input responses before starting work", async () => {
    const createSession = vi.fn();
    const channel = mcpChannel({ auth: none() });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const oversizedStart = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          // 3 bytes per char: well under 64 Ki characters, over 64 KiB.
          arguments: { message: "日".repeat(24 * 1_024) },
          name: "agent_start",
        },
      }),
      routeArgs(createSession),
    );
    await expect(jsonRpcResponse(oversizedStart)).resolves.toMatchObject({
      result: {
        content: [
          { text: expect.stringContaining("Invalid arguments for tool agent_start"), type: "text" },
        ],
        isError: true,
        structuredContent: { error: { code: "invalid_input", retryable: false } },
      },
    });

    const oversizedUpdate = await route.handler(
      mcpRequest({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            invocationId: "inv",
            responses: [{ requestId: "r", text: "日".repeat(6 * 1_024) }],
          },
          name: "agent_update",
        },
      }),
      routeArgs(createSession),
    );
    await expect(jsonRpcResponse(oversizedUpdate)).resolves.toMatchObject({
      result: { isError: true, structuredContent: { error: { code: "invalid_input" } } },
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("mounts OAuth resource metadata and augments auth failures", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(
          () => null,
          [{ parameters: { realm: "eve" }, scheme: "Basic" }, { scheme: "Bearer" }],
        ),
        {
          issuer: "https://issuer.example",
          resource: "https://agent.example/delegate",
          scopes: ["agent:invoke"],
        },
      ),
      route: "/delegate",
    });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource/delegate",
      "HEAD /.well-known/oauth-protected-resource/delegate",
      "OPTIONS /.well-known/oauth-protected-resource/delegate",
      "GET /delegate",
      "POST /delegate",
      "DELETE /delegate",
    ]);

    const metadataRoute = channel.routes[0]!;
    if (metadataRoute.transport === "websocket") throw new Error("expected HTTP route");
    const metadata = await metadataRoute.handler(
      requestWithHost("https://private.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
      scopes_supported: ["agent:invoke"],
    });
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");

    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://private.example/delegate", { method: "POST" }),
      {} as never,
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/delegate"',
    );
    expect(challenge).toContain('Basic realm="eve"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("adds resource metadata only to explicit insufficient-scope responses", async () => {
    const genericChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError();
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const genericRoute = genericChannel.routes[4]!;
    if (genericRoute.transport === "websocket") throw new Error("expected HTTP route");
    const generic = await genericRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    expect(generic.status).toBe(403);
    expect(generic.headers.get("www-authenticate")).toBeNull();

    const scopedChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError({
            challenges: [
              {
                parameters: { error: "insufficient_scope", scope: "agent:admin" },
                scheme: "Bearer",
              },
            ],
          });
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const scopedRoute = scopedChannel.routes[4]!;
    if (scopedRoute.transport === "websocket") throw new Error("expected HTTP route");
    const scoped = await scopedRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    const scopedChallenge = scoped.headers.get("www-authenticate");
    expect(scoped.status).toBe(403);
    expect(scopedChallenge).toContain('error="insufficient_scope"');
    expect(scopedChallenge).toContain('scope="agent:admin"');
    expect(scopedChallenge).not.toContain('scope="agent:invoke"');
    expect(scopedChallenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(scopedChallenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("preserves invalid_token in the OAuth resource challenge", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(() => null, [{ scheme: "Bearer" }]),
        {
          issuer: "https://issuer.example",
          scopes: ["agent:invoke"],
        },
      ),
    });
    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", {
        headers: { authorization: "Bearer expired-token" },
        method: "POST",
      }),
      {} as never,
    );

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("derives the protected resource from the public request origin", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
      route: "/delegate",
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(response.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
    });
  });

  it("allows overriding the protected-resource metadata path", () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, {
        issuer: "https://issuer.example",
        metadataPath: "/.well-known/custom-resource",
      }),
    });
    expect(channel.routes.slice(0, 3).map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/custom-resource",
      "HEAD /.well-known/custom-resource",
      "OPTIONS /.well-known/custom-resource",
    ]);
  });

  it("serves protected-resource metadata to cross-origin browser clients", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
    });
    const [getRoute, headRoute, optionsRoute] = channel.routes;
    if (
      getRoute?.transport === "websocket" ||
      headRoute?.transport === "websocket" ||
      optionsRoute?.transport === "websocket" ||
      getRoute === undefined ||
      headRoute === undefined ||
      optionsRoute === undefined
    ) {
      throw new Error("expected HTTP metadata routes");
    }

    const origin = "https://client.example";
    const get = await getRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
      }),
      {} as never,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");

    const head = await headRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
        method: "HEAD",
      }),
      {} as never,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    expect(head.headers.get("content-type")).toContain("application/json");
    expect(await head.text()).toBe("");

    const options = await optionsRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: {
          "access-control-request-headers": "authorization, mcp-protocol-version",
          "access-control-request-method": "GET",
          origin,
        },
        method: "OPTIONS",
      }),
      {} as never,
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "authorization, mcp-protocol-version",
    );
    expect(options.headers.get("vary")).toBe("Access-Control-Request-Headers");
  });
});

describe("mcpChannel tools", () => {
  const lookup: AgentToolDescription = {
    approval: false,
    description: "Looks up one order.",
    inputSchema: {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
    name: "lookup",
    outputSchema: { properties: { status: { type: "string" } }, type: "object" },
  };
  const shadow: AgentToolDescription = {
    approval: false,
    description: "An authored tool named like the channel's.",
    inputSchema: { type: "object" },
    name: "agent_start",
  };
  const note: AgentToolDescription = {
    approval: false,
    description: "Writes a note.",
    inputSchema: { type: "object" },
    name: "note",
  };

  function serve(
    options: { readonly agent?: boolean; readonly tools?: boolean },
    invokeTool: InvokeToolFn = vi.fn(),
    tools: readonly AgentToolDescription[] = [shadow, lookup, note],
  ) {
    const channel = mcpChannel({ auth: () => principal, ...options });
    const post = channel.routes[1]!;
    if (post.transport === "websocket") throw new Error("expected HTTP route");
    const args = routeArgs(vi.fn(), {
      describe: async () => ({ name: "compiled-agent", skills: [], tools }),
      invokeTool,
    });
    return async (method: string, params?: unknown) =>
      (await jsonRpcResponse(
        await post.handler(mcpRequest({ id: 1, jsonrpc: "2.0", method, params }), args),
      )) as { result?: Record<string, any>; error?: { code: number } };
  }

  it("lists the agent's tools after agent_*, and only them with agent: false", async () => {
    const names = async (rpc: ReturnType<typeof serve>) =>
      (await rpc("tools/list")).result!.tools.map((tool: { name: string }) => tool.name);
    const both = serve({ tools: true });
    expect(await names(both)).toEqual([
      "agent_start",
      "agent_get",
      "agent_update",
      "agent_cancel",
      "lookup",
      "note",
    ]);
    const listed = (await both("tools/list")).result!.tools;
    expect(listed[0].description).toContain("Investigates tasks.");
    expect(listed[4]).toMatchObject({
      inputSchema: lookup.inputSchema,
      outputSchema: lookup.outputSchema,
    });

    const toolsOnly = serve({ agent: false, tools: true });
    expect(await names(toolsOnly)).toEqual(["agent_start", "lookup", "note"]);
    const initialize = await toolsOnly("initialize", {
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
    });
    expect(initialize.result!.instructions).toBeUndefined();

    expect(await names(serve({}))).toHaveLength(4);
    expect(() => mcpChannel({ agent: false, auth: none() })).toThrow(
      "mcpChannel publishes nothing with agent, tools, and skills all false. Enable one.",
    );
  });

  it("describes once per request, and serves skills only from the route's skill files", async () => {
    const describe = vi.fn<() => Promise<AgentDescription>>(async () => ({
      name: "compiled-agent",
      skills: [{ description: "Runs the kennel.", name: "handbook" }],
      tools: [lookup],
    }));
    const files: SkillFileSource = {
      listFiles: async () => [{ path: "SKILL.md", size: 5 }],
      listDirectories: async () => [],
      readFile: async () => new TextEncoder().encode("Body\n"),
    };
    const channel = mcpChannel({ agent: false, auth: () => principal, skills: true, tools: true });
    const post = channel.routes[1]!;
    if (post.transport === "websocket") throw new Error("expected HTTP route");
    const rpc = async (method: string, args: RouteHandlerArgs) =>
      (await jsonRpcResponse(
        await post.handler(mcpRequest({ id: 1, jsonrpc: "2.0", method }), args),
      )) as { result?: Record<string, any>; error?: object };

    const args = attachSkillFileSource(routeArgs(vi.fn(), { describe }), files);
    expect(
      (await rpc("tools/list", args)).result!.tools.map((t: { name: string }) => t.name),
    ).toEqual(["lookup"]);
    expect(describe).toHaveBeenCalledTimes(1);
    expect((await rpc("skills/list", args)).result!.skills).toEqual([
      expect.objectContaining({ uri: "skill://handbook/SKILL.md" }),
    ]);
    expect(describe).toHaveBeenCalledTimes(2);

    // Without the route's skill files the channel cannot serve skills; a
    // tools-only channel never needs them and never touches skill storage.
    const bare = routeArgs(vi.fn(), { describe });
    const response = await post.handler(
      mcpRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      bare,
    );
    expect(response.status).toBe(500);
    const toolsOnly = serve({ agent: false, tools: true });
    expect((await toolsOnly("tools/list")).result!.tools).toHaveLength(3);
  });

  it("returns non-object output as structured content when the tool declares a schema", async () => {
    const count: AgentToolDescription = {
      approval: false,
      description: "Counts orders.",
      inputSchema: { type: "object" },
      name: "count",
      outputSchema: { type: "number" },
    };
    const invokeTool = vi.fn<InvokeToolFn>(async () => ({
      modelOutput: { type: "json", value: 42 },
      output: 42,
      status: "completed",
    }));
    const rpc = serve({ agent: false, tools: true }, invokeTool, [count]);
    const called = (await rpc("tools/call", { arguments: {}, name: "count" })).result!;
    expect(called.isError).toBeUndefined();
    // The SDK wraps a non-object as `{ result }` on 2025-era connections.
    expect(called.structuredContent).toEqual({ result: 42 });
  });

  it("runs each call through invokeTool as the caller and maps its outcome", async () => {
    const completed = (output: unknown, text?: string): InvokeToolResult => ({
      modelOutput:
        text === undefined ? { type: "json", value: output } : { type: "text", value: text },
      output,
      status: "completed",
    });
    const rows: Array<[string, InvokeToolResult, object]> = [
      [
        "lookup",
        completed({ status: "shipped" }),
        {
          content: [{ text: '{"status":"shipped"}', type: "text" }],
          structuredContent: { status: "shipped" },
        },
      ],
      ["note", completed("saved", "Saved."), { content: [{ text: "Saved.", type: "text" }] }],
      ["note", { message: "Bad id.", status: "invalid-input" }, { code: "invalid_input" }],
      // The reason reaches the client verbatim, so an anonymous caller denied a
      // tool session key learns why from `invokeTool`'s own message.
      [
        "note",
        { reason: "Not today.", status: "denied" },
        { code: "denied", message: "Not today." },
      ],
      [
        "note",
        { status: "denied" },
        { code: "denied", message: expect.stringContaining("approval") },
      ],
      ["note", { status: "approval-required" }, { code: "approval_required" }],
      [
        "note",
        { connections: ["linear"], status: "authorization-required" },
        { code: "authorization_required", message: expect.stringContaining("linear") },
      ],
      ["note", { message: "Boom.", status: "failed" }, { code: "internal", message: "Boom." }],
    ];
    for (const [name, result, expected] of rows) {
      const invokeTool = vi.fn<InvokeToolFn>(async () => result);
      const rpc = serve({ tools: true }, invokeTool);
      const args = name === "lookup" ? { id: "7" } : {};
      const called = (await rpc("tools/call", { arguments: args, name })).result!;
      if ("code" in expected) {
        expect(called, result.status).toMatchObject({
          isError: true,
          structuredContent: { error: expected },
        });
      } else {
        expect(called, result.status).toMatchObject(expected);
      }
      expect(invokeTool).toHaveBeenCalledWith(name, args, {
        auth: principal,
        initiator: principal,
        signal: expect.any(AbortSignal),
      });
    }
  });

  it("runs published tools as the user a trusted forwarder names, and agent_* as the forwarder", async () => {
    const alice: SessionAuthContext = {
      attributes: { team: "équipe" },
      authenticator: "oidc",
      principalId: "alice",
      principalType: "user",
    };
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    const bob: SessionAuthContext = { ...alice, attributes: {}, principalId: "bob" };
    const json = JSON.stringify({ current: alice });
    const valid = encode(json);
    const withInitiator = encode(JSON.stringify({ current: alice, initiator: bob }));
    // Unpadded base64url of 12,288 bytes is exactly the 16 KiB cap; JSON whitespace pads it.
    const sized = (bytes: number) => encode(json + " ".repeat(bytes - Buffer.byteLength(json)));
    const trusted = {
      trustedForwarders: (forwarder: SessionAuthContext) => forwarder === principal,
    };
    const forwardedAlice = {
      ...alice,
      attributes: { ...alice.attributes, "eve:forwarded-by": "user-1" },
    };
    const forwardedBob = { ...bob, attributes: { "eve:forwarded-by": "user-1" } };
    function post(
      options: Partial<McpChannelInput>,
      header: string | undefined,
      tool: string,
      overrides: { createSession?: () => Promise<never>; invokeTool?: InvokeToolFn },
    ) {
      const args = routeArgs(overrides.createSession, {
        describe: async () => ({ name: "compiled-agent", skills: [], tools: [note] }),
        invokeTool: overrides.invokeTool,
      });
      const route = mcpChannel({ auth: () => principal, tools: true, ...options }).routes[1]!;
      if (route.transport === "websocket") throw new Error("expected HTTP route");
      const params = { arguments: tool === "agent_start" ? { message: "hi" } : {}, name: tool };
      const body = { id: 1, jsonrpc: "2.0", method: "tools/call", params };
      return route.handler(
        mcpRequest(body, header ? { "eve-forwarded-principal": header } : {}),
        args,
      );
    }
    // [label, header, channel options, expected status or the [current, initiator] the tool runs as, error]
    type Ran = readonly [object, object];
    const rows: Array<[string, string?, Partial<McpChannelInput>?, (number | Ran)?, string?]> = [
      ["no header", undefined, trusted, [principal, principal]],
      ["a valid header", valid, trusted, [forwardedAlice, forwardedAlice]],
      ["a header naming an initiator", withInitiator, trusted, [forwardedAlice, forwardedBob]],
      ["a header at the 16 KiB cap", sized(12_288), trusted, [forwardedAlice, forwardedAlice]],
      ["a padded header", `${valid}=`, trusted, 400, "unpadded base64url"],
      ["not a principal", encode('{"current":{}}'), trusted, 400, "Invalid forwardedPrincipal"],
      ["a header over 16 KiB", sized(12_289), trusted, 400, "at most 16384 bytes"],
      ["an untrusted forwarder", valid, { trustedForwarders: () => false }, 403, "not authorized"],
      [
        "an anonymous forwarder",
        valid,
        { auth: none(), trustedForwarders: () => true },
        403,
        "anonymous",
      ],
      [
        "no trustedForwarders",
        valid,
        {},
        403,
        "This deployment does not accept a forwarded principal.",
      ],
    ];
    for (const [label, header, options, expected, error] of rows) {
      const invokeTool = vi.fn<InvokeToolFn>(async () => ({
        modelOutput: { type: "text", value: "ok" },
        output: "ok",
        status: "completed",
      }));
      const response = await post(options!, header, "note", { invokeTool });
      if (typeof expected === "number") {
        expect(response.status, label).toBe(expected);
        expect(((await response.json()) as { error: string }).error, label).toContain(error);
        expect(invokeTool, label).not.toHaveBeenCalled();
        continue;
      }
      expect(response.status, label).toBe(200);
      const [auth, initiator] = expected as Ran;
      // An accepted header records the verified route principal as the forwarder.
      expect(invokeTool.mock.calls[0]![2], label).toEqual({
        auth,
        initiator,
        signal: expect.any(AbortSignal),
        forwardedBy: auth === principal ? undefined : principal,
      });
    }

    const createSession = vi.fn(async (_input: unknown) => {
      throw new Error("stop after createSession");
    });
    await post(trusted, valid, "agent_start", { createSession: createSession as never });
    expect(createSession.mock.calls[0]![0]).toMatchObject({ auth: principal });
  });

  it("advertises tool sessions and honours a key only from clients that declare them", async () => {
    const channel = mcpChannel({ auth: () => principal, skills: true, tools: true });
    const post = channel.routes[1]!;
    if (post.transport === "websocket") throw new Error("expected HTTP route");
    const invokeTool = vi.fn<InvokeToolFn>(async () => ({
      modelOutput: { type: "text", value: "Saved." },
      output: "saved",
      status: "completed",
    }));
    const files: SkillFileSource = {
      listDirectories: async () => [],
      listFiles: async () => [],
      readFile: async () => new Uint8Array(),
    };
    const args = attachSkillFileSource(
      routeArgs(vi.fn(), {
        describe: async () => ({ name: "compiled-agent", skills: [], tools: [note] }),
        invokeTool,
      }),
      files,
    );
    const modern = (method: string, params: object, capabilities: object) => {
      const headers: Record<string, string> = {
        "mcp-method": method,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      };
      if (method === "tools/call") headers["mcp-name"] = "note";
      return mcpRequest(
        {
          id: 1,
          jsonrpc: "2.0",
          method,
          params: {
            ...params,
            _meta: {
              ...(params as { _meta?: object })._meta,
              "io.modelcontextprotocol/clientCapabilities": capabilities,
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        },
        headers,
      );
    };

    const discovered = (await jsonRpcResponse(
      await post.handler(modern("server/discover", {}, {}), args),
    )) as { result: { capabilities: Record<string, unknown> } };
    // Tool sessions and skills both advertise under `extensions`; neither replaces the other.
    expect(discovered.result.capabilities.extensions).toEqual({
      "dev.eve/tool-sessions": {},
      "io.modelcontextprotocol/skills": { directoryRead: true },
    });

    const declared = { extensions: { "dev.eve/tool-sessions": {} } };
    const call = { _meta: { "dev.eve/tool-session": "desk" }, arguments: {}, name: "note" };
    const rows: Array<[string, Request, string | undefined]> = [
      ["declaring client", modern("tools/call", call, declared), "desk"],
      ["undeclaring client", modern("tools/call", call, {}), undefined],
      [
        "2025-era client",
        mcpRequest({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            ...call,
            _meta: { ...call._meta, "io.modelcontextprotocol/clientCapabilities": declared },
          },
        }),
        undefined,
      ],
    ];
    for (const [client, request, key] of rows) {
      invokeTool.mockClear();
      await post.handler(request, args);
      expect(invokeTool, client).toHaveBeenCalledOnce();
      expect(invokeTool.mock.calls[0]![2].key, client).toBe(key);
    }
  });

  it("scopes a forwarded tool session to the verified router, whatever the header claims", async () => {
    const router = (principalId: string): SessionAuthContext => ({
      ...principal,
      principalId,
      principalType: "service",
    });
    const routers = { a: router("router-a"), b: router("router-b") };
    const channel = mcpChannel({
      auth: (request) => routers[request.headers.get("x-router") as "a" | "b"],
      tools: true,
      trustedForwarders: () => true,
    });
    const post = channel.routes[1]!;
    if (post.transport === "websocket") throw new Error("expected HTTP route");
    const invokeTool = vi.fn<InvokeToolFn>(async () => ({
      modelOutput: { type: "text", value: "ok" },
      output: "ok",
      status: "completed",
    }));
    const args = routeArgs(vi.fn(), {
      describe: async () => ({ name: "compiled-agent", skills: [], tools: [note] }),
      invokeTool,
    });
    const alice: SessionAuthContext = {
      // The asserted user claims router-b; only the route principal counts.
      attributes: { "eve:forwarded-by": "router-b" },
      authenticator: "oidc",
      principalId: "alice",
      principalType: "user",
    };
    const call = (via: "a" | "b") =>
      post.handler(
        mcpRequest(
          {
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              _meta: {
                "dev.eve/tool-session": "desk",
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { "dev.eve/tool-sessions": {} },
                },
                "io.modelcontextprotocol/clientInfo": { name: "router", version: "0.0.0" },
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
              },
              arguments: {},
              name: "note",
            },
          },
          {
            "eve-forwarded-principal": Buffer.from(JSON.stringify({ current: alice })).toString(
              "base64url",
            ),
            "mcp-method": "tools/call",
            "mcp-name": "note",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "x-router": via,
          },
        ),
        args,
      );

    await call("a");
    await call("b");
    const [viaA, viaB] = invokeTool.mock.calls.map((call) => call[2]);
    expect(viaA).toMatchObject({
      auth: { principalId: "alice" },
      forwardedBy: routers.a,
      key: "desk",
    });
    expect(viaB).toMatchObject({
      auth: { principalId: "alice" },
      forwardedBy: routers.b,
      key: "desk",
    });
    expect(deriveToolSessionId({ ...viaA!, current: viaA!.auth, key: "desk" })).not.toBe(
      deriveToolSessionId({ ...viaB!, current: viaB!.auth, key: "desk" }),
    );
  });

  it("checks arguments against the tool's JSON schema before invoking it", async () => {
    const invokeTool = vi.fn<InvokeToolFn>();
    const rpc = serve({ tools: true }, invokeTool);
    const called = await rpc("tools/call", { arguments: { id: 7 }, name: "lookup" });
    expect(called.error).toBeUndefined();
    expect(called.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_input", retryable: false } },
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

function routeArgs(
  createSession: () => Promise<never> = vi.fn(),
  overrides: Partial<RouteHandlerArgs> = {},
): RouteHandlerArgs {
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const args: RouteHandlerArgs = {
    ...mockAgentRouteArgs(),
    ...overrides,
    attachSession: unavailable,
    from: unavailable,
    params: {},
    requestIp: "127.0.0.1",
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  return attachRouteChannelName(
    attachAgentInfoRouteResponse(attachRouteSessionCreator(args, createSession), async () =>
      Response.json({
        agent: {
          description: "Investigates tasks.",
          name: "compiled-agent",
        },
      }),
    ),
    "mcp",
  );
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      ...headers,
    },
    method: "POST",
  });
}

function requestWithHost(url: string, init: RequestInit = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    ...init,
    headers: { host: target.host, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

async function jsonRpcResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return await response.json();
  }
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data.slice("data: ".length));
}
