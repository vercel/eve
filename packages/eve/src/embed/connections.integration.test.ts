import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "#embed/session.js";
import { defineAgent } from "#public/definitions/agent.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createStatefulMcpServer } from "#internal/testing/stateful-mcp-server.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";

afterEach(() => vi.unstubAllGlobals());

// Calls the connection's ping through eve's catalog, then reports what came back.
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const result = prompt
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((part) => part.type === "tool-result");
      if (result?.type === "tool-result") return textStreamResult(JSON.stringify(result.output));
      return toolCallsStreamResult([
        {
          input: JSON.stringify({ input: {}, name: "pinger__ping" }),
          toolCallId: "call-ping",
          toolName: "eve__tool",
        },
      ]);
    },
    modelId: "connections-scripted",
    provider: "eve-test",
  }),
);

describe("a connection on an agent defined in code", () => {
  it("reaches an MCP server's tool through eve's catalog", async () => {
    const server = createStatefulMcpServer();
    vi.stubGlobal("fetch", server.fetch);
    const session = await createSession(
      defineAgent({
        connections: {
          pinger: defineMcpClientConnection({
            description: "A server that answers pings.",
            url: "https://mcp.example.test/mcp",
          }),
        },
        model,
        modelContextWindowTokens: 200_000,
        name: "pinger",
      }),
      { identity: null },
    );
    try {
      const result = await (await session.send("Ping the server.")).result();
      expect(result.status).toBe("completed");
      expect(result.reply).toContain("pong");
      expect(server.requests.some(({ method }) => method === "POST")).toBe(true);
    } finally {
      await session.close();
    }
  });
});
