import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  createMcpStreamableHttpServer,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from "#internal/mcp/streamable-http-server.js";

const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

function modernRequest(
  body: {
    readonly method: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  },
  headers: Record<string, string> = {},
): Request {
  const standardHeaders: Record<string, string> = {
    "mcp-method": body.method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (typeof body.params?.name === "string") standardHeaders["mcp-name"] = body.params.name;

  return request(
    {
      ...body,
      params: {
        ...body.params,
        _meta: {
          [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
          [MCP_CLIENT_INFO_META_KEY]: { name: "eve-test-client", version: "0.0.0" },
          [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        },
      },
    },
    { ...standardHeaders, ...headers },
  );
}

async function jsonRpcResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return await response.json();
  }
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data.slice("data: ".length));
}

function server() {
  const call = vi.fn(async (input: unknown) => ({
    content: [{ text: JSON.stringify(input), type: "text" as const }],
  }));
  return {
    call,
    handle: createMcpStreamableHttpServer({
      authenticate: async () => auth,
      name: "eve-test",
      tools: [
        {
          call,
          definition: {
            description: "Echoes input.",
            inputSchema: z.strictObject({ value: z.number() }),
            name: "echo",
          },
        },
      ],
      version: "0.0.0",
    }),
  };
}

function initialize(handle: (request: Request) => Promise<Response>): Promise<Response> {
  return handle(
    request({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "eve-test-client", version: "0.0.0" },
        protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      },
    }),
  );
}

describe("stateless MCP Streamable HTTP server", () => {
  it("serves MCP 2026-07-28 discovery and tools without initialize", async () => {
    const { handle } = server();
    const discovered = await handle(
      modernRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "server/discover",
      }),
    );
    expect(await jsonRpcResponse(discovered)).toMatchObject({
      id: 1,
      result: {
        supportedVersions: [MCP_PROTOCOL_VERSION],
      },
    });

    const listed = await handle(modernRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }));
    expect(await jsonRpcResponse(listed)).toMatchObject({
      result: { tools: [{ name: "echo" }] },
    });
  });

  it("rejects a modern POST without MCP-Protocol-Version as HeaderMismatch", async () => {
    const { handle } = server();
    const response = await handle(
      request(
        {
          id: "missing-version",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
              [MCP_CLIENT_INFO_META_KEY]: { name: "eve-test-client", version: "0.0.0" },
              [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
            },
          },
        },
        { "mcp-method": "server/discover" },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32_020,
        message: "Missing MCP-Protocol-Version header",
      },
      id: "missing-version",
      jsonrpc: "2.0",
    });
  });

  it("preserves malformed and unsupported modern envelope errors", async () => {
    const { handle } = server();
    const malformed = await handle(
      request(
        {
          id: "malformed-envelope",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
            },
          },
        },
        { "mcp-method": "server/discover" },
      ),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: -32_602 },
      id: "malformed-envelope",
    });

    const unsupported = await handle(
      request(
        {
          id: "unsupported-version",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
              [MCP_CLIENT_INFO_META_KEY]: { name: "eve-test-client", version: "0.0.0" },
              [MCP_PROTOCOL_VERSION_META_KEY]: "2027-01-01",
            },
          },
        },
        { "mcp-method": "server/discover" },
      ),
    );
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: -32_022, data: { supported: [MCP_PROTOCOL_VERSION] } },
      id: "unsupported-version",
    });
  });

  it("does not route a malformed modern request through the legacy handler", async () => {
    const { handle } = server();
    const response = await handle(
      request(
        {
          id: "missing-meta",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {},
        },
        {
          "mcp-method": "server/discover",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32_602 },
      id: "missing-meta",
      jsonrpc: "2.0",
    });
  });

  it("keeps stateless compatibility with 2025 clients", async () => {
    const { handle } = server();
    const initialized = await initialize(handle);
    expect(await jsonRpcResponse(initialized)).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: { listChanged: true } },
        protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        serverInfo: { name: "eve-test", version: "0.0.0" },
      },
    });
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    const listed = await handle(request({ id: 2, jsonrpc: "2.0", method: "tools/list" }));
    expect(await jsonRpcResponse(listed)).toMatchObject({
      result: { tools: [{ name: "echo" }] },
    });
  });

  it("calls modern tools with authenticated context and request cancellation", async () => {
    const { call, handle } = server();
    const response = await handle(
      modernRequest({
        id: "call-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { value: 42 }, name: "echo" },
      }),
    );
    expect(await jsonRpcResponse(response)).toMatchObject({
      id: "call-1",
      result: { content: [{ text: '{"value":42}', type: "text" }] },
    });
    expect(call).toHaveBeenCalledWith(
      { value: 42 },
      expect.objectContaining({ auth, signal: expect.any(AbortSignal) }),
    );
  });

  it("enforces the advertised tool input schema before dispatch", async () => {
    const { call, handle } = server();
    const response = await handle(
      modernRequest({
        id: "invalid-call",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { extra: true, value: "not-a-number" }, name: "echo" },
      }),
    );

    expect(await jsonRpcResponse(response)).toMatchObject({
      id: "invalid-call",
      result: {
        content: [{ text: expect.stringContaining("Invalid input"), type: "text" }],
        isError: true,
      },
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("enforces the advertised tool output schema", async () => {
    const handle = createMcpStreamableHttpServer({
      authenticate: async () => auth,
      name: "eve-test",
      tools: [
        {
          call: async () => ({
            content: [{ text: "invalid", type: "text" }],
            structuredContent: { value: "not-a-number" },
          }),
          definition: {
            inputSchema: z.object({}),
            name: "invalid-output",
            outputSchema: z.strictObject({ value: z.number() }),
          },
        },
      ],
      version: "0.0.0",
    });

    const response = await handle(
      modernRequest({
        id: "invalid-output",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "invalid-output" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32_602, message: "Tool result does not match its outputSchema" },
      id: "invalid-output",
    });
  });

  it("returns JSON-RPC errors and acknowledges notifications", async () => {
    const { handle } = server();
    const unknown = await handle(modernRequest({ id: 3, jsonrpc: "2.0", method: "unknown" }));
    expect(await jsonRpcResponse(unknown)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
      id: 3,
      jsonrpc: "2.0",
    });

    const notification = await handle(
      modernRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it("does not expose MCP primitives that eve does not advertise", async () => {
    const { handle } = server();
    for (const method of ["completion/complete", "prompts/list", "resources/list"]) {
      const response = await handle(modernRequest({ id: method, jsonrpc: "2.0", method }));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32_601, message: "Method not found" },
        id: method,
      });
    }

    const mismatch = await handle(
      modernRequest(
        { id: "mismatch", jsonrpc: "2.0", method: "tools/list" },
        { "mcp-method": "prompts/list" },
      ),
    );
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: -32_020 },
      id: "mismatch",
    });
  });

  it("authenticates before transport handling", async () => {
    const challenge = new Response(null, {
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
      },
      status: 401,
    });
    const handle = createMcpStreamableHttpServer({
      authenticate: async () => challenge,
      name: "test",
      tools: [],
      version: "0",
    });

    const unauthorized = await handle(request("not relevant"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");

    const streamed = await handle(new Request("https://agent.example/mcp"));
    expect(streamed.status).toBe(401);

    const deleted = await handle(new Request("https://agent.example/mcp", { method: "DELETE" }));
    expect(deleted.status).toBe(401);
  });

  it("does not open a process-local session for authenticated GET", async () => {
    const response = await server().handle(
      new Request("https://agent.example/mcp", {
        headers: { accept: "text/event-stream" },
      }),
    );

    expect(response.status).toBe(405);
  });

  it("enforces Streamable HTTP media types", async () => {
    const response = await server().handle(
      request(
        {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "eve-test-client", version: "0.0.0" },
            protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
          },
        },
        { accept: "application/json" },
      ),
    );

    expect(response.status).toBe(406);
    expect(await jsonRpcResponse(response)).toMatchObject({ error: { code: -32000 } });
  });

  it("bounds compatibility preflight parsing before the transport reads the body", async () => {
    const { handle } = server();
    const response = await handle(
      request({ padding: "x".repeat(4 * 1024 * 1024), method: "tools/list" }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
  });

  it("rejects duplicate tool names at construction", () => {
    const tool = {
      call: async () => ({ content: [] }),
      definition: { inputSchema: z.object({}), name: "duplicate" },
    };
    expect(() =>
      createMcpStreamableHttpServer({
        authenticate: async () => auth,
        name: "test",
        tools: [tool, tool],
        version: "0",
      }),
    ).toThrow("MCP tool names must be unique");
  });
});
