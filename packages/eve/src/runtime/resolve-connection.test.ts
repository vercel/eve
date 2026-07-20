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
});
