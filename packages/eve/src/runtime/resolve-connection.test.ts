import { describe, expect, it } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledConnectionDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import type { ConnectionAuthResolver, HeadersDefinition } from "#runtime/connections/types.js";

const mcpCompiledDef: CompiledConnectionDefinition = {
  connectionName: "test-mcp",
  description: "Test MCP connection",
  logicalPath: "connections/test-mcp.ts",
  protocol: "mcp",
  sourceId: "connections/test-mcp",
  sourceKind: "module",
  url: "https://mcp.example.com",
};

function moduleMapReturning(exportValue: Record<string, unknown>): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [mcpCompiledDef.sourceId]: {
            default: exportValue,
          },
        },
      },
    },
  };
}

describe("resolveConnectionDefinition", () => {
  it("preserves context-aware auth and header callbacks for request-time resolution", async () => {
    const auth: ConnectionAuthResolver = (ctx) => ({
      getToken: async () => ({ token: ctx.session.id }),
    });
    const headers: HeadersDefinition = (ctx) => ({ "X-Session": ctx.session.id });
    const definition: CompiledConnectionDefinition = {
      connectionName: "warehouse",
      description: "Tenant warehouse",
      logicalPath: "connections/warehouse.ts",
      protocol: "mcp",
      sourceId: "connections/warehouse",
      sourceKind: "module",
      url: "https://warehouse.example.com/mcp",
    };
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [definition.sourceId]: {
              default: {
                auth,
                description: definition.description,
                headers,
                url: definition.url,
              },
            },
          },
        },
      },
    };

    const resolved = await resolveConnectionDefinition(definition, moduleMap, undefined);

    expect(resolved.authorization).toBe(auth);
    expect(resolved.headers).toBe(headers);
  });

  it('carries session: "stateful" through to the resolved definition', async () => {
    const resolved = await resolveConnectionDefinition(
      mcpCompiledDef,
      moduleMapReturning({
        url: "https://mcp.example.com",
        description: "test",
        session: "stateful",
      }),
      undefined,
    );
    expect(resolved.session).toBe("stateful");
  });

  it("leaves session undefined when not set", async () => {
    const resolved = await resolveConnectionDefinition(
      mcpCompiledDef,
      moduleMapReturning({ url: "https://mcp.example.com", description: "test" }),
      undefined,
    );
    expect(resolved.session).toBeUndefined();
  });
});
