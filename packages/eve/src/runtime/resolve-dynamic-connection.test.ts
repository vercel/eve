import { describe, expect, it } from "vitest";

import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledDynamicConnectionDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#public/definitions/connections/dynamic.js";
import { resolveDynamicConnectionDefinition } from "#runtime/resolve-dynamic-connection.js";

describe("resolveDynamicConnectionDefinition", () => {
  it("reattaches the authored event handlers", async () => {
    const handler = () => null;
    const definition: CompiledDynamicConnectionDefinition = {
      eventNames: ["session.started"],
      logicalPath: "connections/accounts.ts",
      slug: "accounts",
      sourceId: "connections/accounts",
      sourceKind: "module",
    };
    const moduleMap: CompiledModuleMap = {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [definition.sourceId]: {
              default: defineDynamic({ events: { "session.started": handler } }),
            },
          },
        },
      },
    };

    await expect(
      resolveDynamicConnectionDefinition(definition, moduleMap, undefined),
    ).resolves.toMatchObject({
      eventNames: ["session.started"],
      events: { "session.started": handler },
      slug: "accounts",
    });
  });
});
