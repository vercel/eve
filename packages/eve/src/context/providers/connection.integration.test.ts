import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { connectionProvider } from "#context/providers/connection.js";
import type { HarnessSession } from "#harness/types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { disposeSessionConnectionRegistry } from "#runtime/connections/registry-cache.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

const TOOLS = [
  {
    description: "Returns the provided text.",
    inputSchema: {
      properties: { text: { type: "string" } },
      required: ["text"],
      type: "object",
    },
    name: "echo",
  },
];

function createContext(
  connections: readonly ResolvedConnectionDefinition[],
  turnId: string = "turn-1",
): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { root: { agent: { connections } } },
  } as never);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: turnId, sequence: 0 },
  });
  return ctx;
}

describe("connectionProvider", () => {
  it("reuses one MCP client across durable steps in the same session", async () => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        methods.push(request.method ?? "UNKNOWN");
        response.writeHead(405).end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { arguments?: { text?: string }; protocolVersion?: string };
      };
      methods.push(message.method);

      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }

      const result =
        message.method === "initialize"
          ? {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
              serverInfo: { name: "handshake-probe", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: TOOLS }
            : message.method === "tools/call"
              ? {
                  content: [
                    {
                      text: String(message.params?.arguments?.text ?? ""),
                      type: "text",
                    },
                  ],
                }
              : {};

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the MCP probe server to listen on a TCP port.");
    }

    const connections: readonly ResolvedConnectionDefinition[] = [
      {
        connectionName: "probe",
        description: "MCP handshake probe",
        logicalPath: "connections/probe.ts",
        protocol: "mcp",
        sourceId: "connections/probe",
        sourceKind: "module",
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
    ];
    const session = { sessionId: "session-1" } as HarnessSession;

    try {
      await withRuntimeSession(createRuntimeSession("connection-provider-test"), async () => {
        const discoveryRegistry = (
          await connectionProvider.create(createContext(connections, "turn-1-actual"), session)
        )?.value;
        await discoveryRegistry?.getClient("probe").getToolMetadata();

        const executionRegistry = (
          await connectionProvider.create(createContext(connections), session)
        )?.value;
        await executionRegistry?.getClient("probe").executeTool("echo", { text: "marigold" });

        expect(executionRegistry).toBe(discoveryRegistry);
        expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
        expect(methods.filter((method) => method === "tools/list")).toHaveLength(1);
        expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
        expect(methods.filter((method) => method === "GET")).toHaveLength(1);

        await disposeSessionConnectionRegistry(session.sessionId);
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
