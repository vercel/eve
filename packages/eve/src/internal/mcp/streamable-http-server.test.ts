import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { z } from "#compiled/zod/index.js";
import {
  createMcpStreamableHttpServer,
  defineMcpTool,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_REQUEST_BODY_MAX_BYTES,
  McpToolOperationError,
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
        defineMcpTool({
          call,
          definition: {
            description: "Echoes input.",
            inputSchema: z.strictObject({ value: z.number() }),
            name: "echo",
          },
        }),
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
        message: expect.stringContaining("MCP-Protocol-Version header is absent"),
      },
      id: "missing-version",
      jsonrpc: "2.0",
    });
  });

  it("leaves malformed and unsupported modern envelopes to earlier SDK validation rungs", async () => {
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
      error: { code: -32_022 },
      id: "unsupported-version",
    });
  });

  it("keeps stateless compatibility with 2025 clients", async () => {
    const { handle } = server();
    const initialized = await initialize(handle);
    expect(await jsonRpcResponse(initialized)).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
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

  it("calls modern tools with authenticated context and SDK cancellation", async () => {
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
        content: [{ text: expect.stringContaining("Input validation error"), type: "text" }],
        isError: true,
      },
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("returns structured operation errors for expected tool failures", async () => {
    const handle = createMcpStreamableHttpServer({
      authenticate: async () => auth,
      name: "eve-test",
      tools: [
        defineMcpTool({
          call: async () => {
            throw new McpToolOperationError("conflict", "Invocation is not waiting for input.");
          },
          definition: { inputSchema: z.strictObject({}), name: "conflicting" },
        }),
      ],
      version: "0.0.0",
    });

    for (const request_ of [
      modernRequest({
        id: "modern",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "conflicting" },
      }),
      request({
        id: "legacy",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "conflicting" },
      }),
    ]) {
      await expect(jsonRpcResponse(await handle(request_))).resolves.toMatchObject({
        result: {
          content: [{ text: "Invocation is not waiting for input.", type: "text" }],
          isError: true,
          structuredContent: {
            error: {
              code: "conflict",
              message: "Invocation is not waiting for input.",
              retryable: true,
            },
          },
        },
      });
    }
  });

  it("sanitizes unexpected tool failures behind an error id", async () => {
    const handle = createMcpStreamableHttpServer({
      authenticate: async () => auth,
      name: "eve-test",
      tools: [
        defineMcpTool({
          call: async () => {
            throw new Error("ECONNREFUSED 10.0.0.7:5432 while reading secret=abc");
          },
          definition: { inputSchema: z.strictObject({}), name: "exploding" },
        }),
      ],
      version: "0.0.0",
    });

    const body = (await jsonRpcResponse(
      await handle(
        modernRequest({
          id: "boom",
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "exploding" },
        }),
      ),
    )) as {
      result: {
        content: Array<{ text: string }>;
        isError: boolean;
        structuredContent: { error: Record<string, unknown> };
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toMatchObject({
      code: "internal",
      errorId: expect.any(String),
      retryable: false,
    });
    expect(JSON.stringify(body.result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body.result)).not.toContain("secret=");
    expect(body.result.content[0]?.text).toContain(
      String(body.result.structuredContent.error.errorId),
    );
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
      request(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          "mcp-method": "notifications/initialized",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
      ),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
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

  it("bounds every POST body before the transport reads it", async () => {
    const { call, handle } = server();
    const padding = "x".repeat(MCP_REQUEST_BODY_MAX_BYTES + 1);
    const oversized = [
      // Legacy-era request without a protocol version header.
      request({ id: 1, jsonrpc: "2.0", method: "tools/list", params: { padding } }),
      // Legacy-era request that declares the 2025 header.
      request(
        { id: 2, jsonrpc: "2.0", method: "tools/list", params: { padding } },
        { "mcp-protocol-version": MCP_LEGACY_PROTOCOL_VERSION },
      ),
      // Modern-era request with a complete envelope and header.
      modernRequest({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { value: 1, padding }, name: "echo" },
      }),
    ];

    for (const oversizedRequest of oversized) {
      const response = await handle(oversizedRequest);
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32_000, message: "Request body too large" },
        id: null,
        jsonrpc: "2.0",
      });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("fails fast on an oversized declared content length", async () => {
    const { handle } = server();
    const response = await handle(
      new Request("https://agent.example/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-length": String(MCP_REQUEST_BODY_MAX_BYTES + 1),
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON on every POST path with a parse error", async () => {
    const { handle } = server();
    const response = await handle(
      new Request("https://agent.example/mcp", {
        body: "{not json",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32_700 } });
  });

  it("rejects duplicate tool names at construction", () => {
    const tool = defineMcpTool({
      call: async () => ({ content: [] }),
      definition: { inputSchema: z.strictObject({}), name: "duplicate" },
    });
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
