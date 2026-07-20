import { describe, expect, it, vi } from "vitest";

import {
  createMcpStreamableHttpServer,
  MCP_PROTOCOL_VERSION,
} from "#internal/mcp/streamable-http-server.js";
import type { SessionAuthContext } from "#channel/types.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

function request(body: unknown): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
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
            inputSchema: { type: "object" },
            name: "echo",
          },
        },
      ],
      version: "0.0.0",
    }),
  };
}

describe("stateless MCP Streamable HTTP server", () => {
  it("negotiates initialize and advertises tools", async () => {
    const { handle } = server();
    const initialized = await handle(
      request({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      }),
    );
    expect(await initialized.json()).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    });
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    const listed = await handle(request({ id: 2, jsonrpc: "2.0", method: "tools/list" }));
    expect(await listed.json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  });

  it("calls tools with authenticated context", async () => {
    const { call, handle } = server();
    const response = await handle(
      request({
        id: "call-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { value: 42 }, name: "echo" },
      }),
    );
    expect(await response.json()).toMatchObject({
      id: "call-1",
      result: { content: [{ text: '{"value":42}', type: "text" }] },
    });
    expect(call).toHaveBeenCalledWith({ value: 42 }, expect.objectContaining({ auth }));
  });

  it("returns JSON-RPC errors and acknowledges notifications", async () => {
    const { handle } = server();
    const unknown = await handle(request({ id: 3, jsonrpc: "2.0", method: "unknown" }));
    expect(await unknown.json()).toEqual({
      error: { code: -32601, message: "Method not found." },
      id: 3,
      jsonrpc: "2.0",
    });

    const notification = await handle(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it("authenticates before parsing and rejects DELETE for a stateless server", async () => {
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

    const deleted = await handle(new Request("https://agent.example/mcp", { method: "DELETE" }));
    expect(deleted.status).toBe(405);
  });
});
