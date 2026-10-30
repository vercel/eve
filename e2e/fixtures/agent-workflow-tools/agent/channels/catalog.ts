import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});

const rpcCall = rpcRequest.extend({
  params: z.object({ name: z.string().optional() }).optional(),
});

const rpcReply = (id: string | number, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });

const textResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/**
 * A server that, like a catalog with a public storefront, answers `initialize`,
 * `tools/list`, and `list_items` without a token. Only `list_orders` needs
 * sign-in, and it answers `401` until the request carries the bearer.
 */
async function publicCatalog(request: Request): Promise<Response> {
  const signedIn = request.headers.get("authorization") === "Bearer authorized-fixture-token";
  const { id, method, params } = rpcCall.parse(await request.json());
  if (id === undefined) return new Response(null, { status: 202 });
  switch (method) {
    case "initialize":
      return rpcReply(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-public-catalog", version: "1.0.0" },
      });
    case "tools/list":
      return rpcReply(id, {
        tools: [
          {
            name: "list_items",
            description: "List catalog items. Public.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "list_orders",
            description: "List the signed-in user's orders.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    case "tools/call":
      if (params?.name === "list_items") return rpcReply(id, textResult({ items: ["Lamp"] }));
      if (params?.name === "list_orders") {
        if (!signedIn) return new Response("Unauthorized", { status: 401 });
        return rpcReply(id, textResult({ orders: ["Alice's lamp"], signedIn }));
      }
      break;
  }
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
}

// A fixture-owned MCP server: eve still resolves auth and performs real HTTP discovery.
export default defineChannel({
  routes: [
    GET("/fixture-public-catalog/mcp", async () => new Response(null, { status: 405 })),
    POST("/fixture-public-catalog/mcp", publicCatalog),
    GET("/fixture-catalog/mcp", async () => new Response(null, { status: 405 })),
    POST("/fixture-catalog/mcp", async (request) => {
      if (request.headers.get("authorization") !== "Bearer authorized-fixture-token") {
        return new Response("Unauthorized", { status: 401 });
      }

      const { id, method } = rpcRequest.parse(await request.json());
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }

      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-catalog", version: "1.0.0" },
          },
        });
      }

      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "list_items",
                description: "List catalog items.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ items: ["Alice's lamp"] }) }],
          },
        });
      }

      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    }),
  ],
});
