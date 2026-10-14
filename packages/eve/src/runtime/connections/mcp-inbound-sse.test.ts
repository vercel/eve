import { describe, expect, it, vi } from "vitest";

import { createMCPClient } from "#compiled/@ai-sdk/mcp/index.js";

const SESSION_ID = "session-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "mcp-session-id": SESSION_ID },
  });
}

describe("compiled HttpMCPTransport inbound SSE", () => {
  // #4379: a second GET while the first is in flight gets 409 from servers
  // that allow one standalone stream per session.
  it.fails("opens at most one inbound GET per session while one is in flight", async () => {
    const sessionGets: Promise<unknown>[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseGets!: () => void;
    const getGate = new Promise<void>((resolve) => {
      releaseGets = resolve;
    });

    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        if (request.headers.get("mcp-session-id") !== SESSION_ID) {
          return new Response(null, { status: 400 });
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gated = getGate.then(() => {
          inFlight -= 1;
          return new Response(":\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        });
        sessionGets.push(gated);
        return await gated;
      }
      if (request.method === "DELETE") return new Response(null, { status: 200 });

      const message = (await request.json()) as { id?: number; method?: string };
      if (message.method === "server/discover") return new Response(null, { status: 405 });
      if (message.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { "mcp-session-id": SESSION_ID } });
      }
      throw new Error(`Unexpected MCP request: ${request.method} ${message.method}`);
    };

    const client = await createMCPClient({
      onUncaughtError: vi.fn(),
      transport: { fetch: fakeFetch, type: "http", url: "http://127.0.0.1:8000/mcp" },
    });
    try {
      // Let every start the connect handshake triggered reach the server.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sessionGets.length).toBeGreaterThan(0);
      expect(maxInFlight).toBe(1);
    } finally {
      releaseGets();
      await Promise.allSettled(sessionGets);
      await client.close();
    }
  });
});
