import { afterEach, describe, expect, it, vi } from "vitest";

import { createMCPClient } from "#compiled/@ai-sdk/mcp/index.js";
import {
  createStatefulMcpServer,
  type StatefulMcpServer,
} from "#internal/testing/stateful-mcp-server.js";

const SERVER_URL = "http://127.0.0.1:8000/mcp";

function inboundGets(server: StatefulMcpServer) {
  return server.requests.filter((request) => request.method === "GET");
}

// A 2025-era session allows one standalone GET stream. The MCP SDK server
// answers a second with 409, and stateful gateways drop the session (#4379).
describe("compiled HttpMCPTransport inbound SSE stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one stream per connect, after the session exists", async () => {
    const server = createStatefulMcpServer();
    const client = await createMCPClient({
      onUncaughtError: vi.fn(),
      transport: { fetch: server.fetch, type: "http", url: SERVER_URL },
    });
    const [sessionId] = server.liveSessions;
    try {
      await server.waitForRequest((request) => request.method === "GET" && request.status === 200);
    } finally {
      await client.close();
    }

    expect(inboundGets(server)).toEqual([{ method: "GET", sessionId, status: 200 }]);
  });

  it("does not reopen the stream from a reconnect timer once a stream is attached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const server = createStatefulMcpServer();
    // The first session GET fails at the network layer, which schedules a
    // reconnect. The `notifications/initialized` 202 then opens a stream
    // before that reconnect fires.
    let markDropped!: () => void;
    const dropped = new Promise<void>((resolve) => {
      markDropped = resolve;
    });
    let droppedGets = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET" && request.headers.has("mcp-session-id") && droppedGets === 0) {
        droppedGets += 1;
        markDropped();
        throw new TypeError("fetch failed");
      }
      if (request.method === "POST") {
        const message = (await request.clone().json()) as { method?: string };
        if (message.method === "notifications/initialized") await dropped;
      }
      return await server.fetch(request);
    };

    const client = await createMCPClient({
      onUncaughtError: vi.fn(),
      transport: { fetch, type: "http", url: SERVER_URL },
    });
    const [sessionId] = server.liveSessions;
    try {
      await server.waitForRequest((request) => request.method === "GET" && request.status === 200);
      // Past every reconnect delay the transport could have scheduled.
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      await client.close();
    }

    expect(droppedGets).toBe(1);
    expect(inboundGets(server)).toEqual([{ method: "GET", sessionId, status: 200 }]);
  });
});
