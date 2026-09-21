import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledConnectionDefinition,
} from "#compiler/manifest.js";
import { normalizeMcpClientConnectionDefinition } from "#internal/authored-definition/connection.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import {
  resolveConnectionDefinition,
  resolveDynamicConnectionValue,
} from "#runtime/resolve-connection.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";

describe.each(["static", "dynamic"] as const)(
  "%s MCP protocol configuration with the bundled client",
  (kind) => {
    const requests: { method: string; protocolVersion: string | null }[] = [];
    let client: McpConnectionClient;
    let discoveryError: { code: number; message: string; data?: unknown } | undefined;
    let initializeError: { code: number; message: string } | undefined;

    async function createClient(protocolVersionDiscovery?: boolean) {
      const authored = defineMcpClientConnection({
        description: "Support cases",
        headers: { Authorization: "Bearer fixture-token", "X-Workspace": "fixture-workspace" },
        instanceKey: "fixture-workspace",
        protocolVersionDiscovery,
        url: "https://mcp.example.com/mcp",
      });
      const normalized = normalizeMcpClientConnectionDefinition(authored, "Invalid connection:");
      const compiled: CompiledConnectionDefinition = {
        connectionName: "plain",
        description: normalized.description,
        logicalPath: "connections/plain.ts",
        protocol: "mcp",
        sourceId: "connections/plain",
        sourceKind: "module",
        url: normalized.url,
      };
      const resolved =
        kind === "dynamic"
          ? resolveDynamicConnectionValue(authored, compiled)
          : await resolveConnectionDefinition(
              compiled,
              {
                nodes: {
                  [ROOT_COMPILED_AGENT_NODE_ID]: {
                    modules: { [compiled.sourceId]: { default: authored } },
                  },
                },
              },
              undefined,
            );
      client = new McpConnectionClient(resolved);
      return client;
    }

    beforeEach(() => {
      requests.length = 0;
      discoveryError = {
        code: -32022,
        data: {
          requested: "2026-07-28",
          supported: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"],
        },
        message: "Unsupported protocol version",
      };
      initializeError = undefined;

      // Replace only HTTP I/O: eve's connection, bundled SDK, and protocol parsing stay real.
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://mcp.example.com/mcp");
        expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");
        expect(request.headers.get("X-Workspace")).toBe("fixture-workspace");
        expect(request.method).toBe("POST");
        const message = (await request.json()) as {
          id?: number;
          method: string;
          params?: { name?: string; protocolVersion?: string };
        };
        const protocolVersion = request.headers.get("MCP-Protocol-Version");
        requests.push({ method: message.method, protocolVersion });

        let result: Record<string, unknown>;
        switch (message.method) {
          case "server/discover":
            if (discoveryError !== undefined) {
              return Response.json({ jsonrpc: "2.0", id: message.id, error: discoveryError });
            }
            result = { capabilities: { tools: {} }, supportedVersions: ["2026-07-28"] };
            break;
          case "initialize":
            expect(protocolVersion).toBe("2025-11-25");
            expect(message.params?.protocolVersion).toBe("2025-11-25");
            if (initializeError !== undefined) {
              return Response.json({ jsonrpc: "2.0", id: message.id, error: initializeError });
            }
            result = {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "support-fixture", version: "1.0.0" },
            };
            break;
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            result = {
              tools: [{ name: "getMyUser", inputSchema: { type: "object", properties: {} } }],
            };
            break;
          case "tools/call":
            expect(message.params?.name).toBe("getMyUser");
            result = { content: [{ type: "text", text: "fixture-user" }] };
            break;
          default:
            throw new Error(`Unexpected MCP method: ${message.method}`);
        }
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: protocolVersion === "2026-07-28" ? { ...result, resultType: "complete" } : result,
        });
      });
    });

    afterEach(async () => {
      await client?.close();
      vi.unstubAllGlobals();
    });

    it("initializes and calls Plain-style tools with discovery disabled", async () => {
      await createClient(false);
      await expect(client.getToolMetadata()).resolves.toEqual([
        expect.objectContaining({ name: "getMyUser" }),
      ]);
      await expect(client.executeTool("getMyUser", {}, { callId: "read-user" })).resolves.toEqual({
        content: [{ type: "text", text: "fixture-user" }],
        isError: false,
      });
      expect(requests).toEqual([
        { method: "initialize", protocolVersion: "2025-11-25" },
        { method: "notifications/initialized", protocolVersion: "2025-11-25" },
        { method: "tools/list", protocolVersion: "2025-11-25" },
        { method: "tools/call", protocolVersion: "2025-11-25" },
      ]);
    });

    it.each([undefined, true])("keeps discovery enabled when the option is %s", async (option) => {
      await createClient(option);
      discoveryError = undefined;
      await expect(client.getToolMetadata()).resolves.toEqual([
        expect.objectContaining({ name: "getMyUser" }),
      ]);
      expect(requests).toEqual([
        { method: "server/discover", protocolVersion: "2026-07-28" },
        { method: "tools/list", protocolVersion: "2026-07-28" },
      ]);
    });

    it("preserves Plain's version error when discovery is not disabled", async () => {
      await createClient();
      await expect(client.connect()).rejects.toMatchObject(discoveryError!);
      expect(requests).toEqual([{ method: "server/discover", protocolVersion: "2026-07-28" }]);
    });

    it("propagates a failed handshake without retrying it or switching transports", async () => {
      await createClient(false);
      initializeError = { code: -32603, message: "Initialization failed" };
      await expect(client.connect()).rejects.toMatchObject(initializeError);
      expect(requests).toEqual([{ method: "initialize", protocolVersion: "2025-11-25" }]);
    });
  },
);
