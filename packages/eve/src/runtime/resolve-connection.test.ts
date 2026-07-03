import { describe, expect, it } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledConnectionDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveConnectionDefinition } from "#runtime/resolve-connection.js";
import type { ConnectionAuthResolver, HeadersDefinition } from "#runtime/connections/types.js";

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

  it("prefers the URL produced by the re-imported module over the manifest snapshot", async () => {
    const definition: CompiledConnectionDefinition = {
      connectionName: "backlog",
      description: "Backlog MCP",
      logicalPath: "connections/backlog.ts",
      protocol: "mcp",
      sourceId: "connections/backlog",
      sourceKind: "module",
      url: "http://backlog-mcp.invalid/mcp",
    };
    const runtimeUrl = "https://backlog-mcp.internal.vercel/mcp";
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [definition.sourceId]: {
              default: {
                description: definition.description,
                url: runtimeUrl,
              },
            },
          },
        },
      },
    };

    const resolved = await resolveConnectionDefinition(definition, moduleMap, undefined);

    expect(resolved.url).toBe(runtimeUrl);
  });

  it("falls back to the manifest URL when the module omits or blanks it", async () => {
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
                description: definition.description,
                url: "",
              },
            },
          },
        },
      },
    };

    const resolved = await resolveConnectionDefinition(definition, moduleMap, undefined);

    expect(resolved.url).toBe(definition.url);
  });
});
