import { createMCPClient } from "#compiled/@ai-sdk/mcp/index.js";
import { describe, expect, it, vi } from "vitest";

import { withMcpToolResultCompatibility } from "#runtime/connections/mcp-client.js";

describe("MCP client tool result compatibility", () => {
  it("accepts structured tool results that omit content", async () => {
    const structuredContent = { products: [{ id: "gid://shopify/Product/1", title: "Boots" }] };
    const inner = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; id?: number };
      if (request.method === "initialize") {
        return jsonRpcResponse(request.id, {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "catalog", version: "1.0.0" },
        });
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (request.method === "tools/call") {
        return jsonRpcResponse(request.id, { structuredContent });
      }
      throw new Error(`Unexpected MCP method: ${request.method}`);
    });
    const client = await createMCPClient({
      transport: {
        fetch: withMcpToolResultCompatibility(inner),
        type: "http",
        url: "https://catalog.example.com/mcp",
      },
    });

    try {
      await expect(client.callTool({ arguments: {}, name: "search_catalog" })).resolves.toEqual({
        content: [{ text: JSON.stringify(structuredContent), type: "text" }],
        isError: false,
        structuredContent,
      });
    } finally {
      await client.close();
    }
  });

  it("preserves an existing content field", async () => {
    const body = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: {
        content: [{ text: "Already projected", type: "text" }],
        structuredContent: { value: 1 },
      },
    });
    const wrapped = withMcpToolResultCompatibility(
      vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    );

    const response = await wrapped("https://catalog.example.com/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call" }),
      method: "POST",
    });

    await expect(response.text()).resolves.toBe(body);
  });
});

function jsonRpcResponse(id: number | undefined, result: unknown): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}
