import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});

// A fixture-owned MCP server: eve still resolves auth and performs real HTTP discovery.
export default defineChannel({
  routes: [
    GET("/fixture-service/catalog", async () => new Response(null, { status: 405 })),
    POST("/fixture-service/catalog", async (request) => {
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

      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    }),
  ],
});
