import { describe, expect, it } from "vitest";

import { GET, defineChannel } from "#public/definitions/channel.js";
import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveChannelDefinition } from "#runtime/resolve-channel.js";

const SOURCE_ID = "channels/status";

function definition(urlPath: string): CompiledChannelDefinition {
  return {
    kind: "channel",
    logicalPath: "channels/status.ts",
    method: "GET",
    name: "status",
    sourceId: SOURCE_ID,
    sourceKind: "module",
    urlPath,
  };
}

function moduleMap(urlPath: string): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [SOURCE_ID]: {
            default: defineChannel({
              routes: [GET(urlPath, async () => new Response("ok"))],
            }),
          },
        },
      },
    },
  };
}

describe("resolveChannelDefinition", () => {
  it("resolves only the handler selected by the compiled route plan", async () => {
    const resolved = await resolveChannelDefinition(
      definition("/status"),
      moduleMap("/status"),
      undefined,
    );

    expect(resolved.handler).toBeTypeOf("function");
    expect(resolved).not.toHaveProperty("fetch");
  });

  it("reattaches an authored trailing-slash route to its canonical compiled path", async () => {
    const resolved = await resolveChannelDefinition(
      definition("/status"),
      moduleMap("/status/"),
      undefined,
    );

    expect(resolved.handler).toBeTypeOf("function");
  });

  it("rejects a compiled route missing from the selected channel export", async () => {
    await expect(
      resolveChannelDefinition(definition("/compiled"), moduleMap("/actual"), undefined),
    ).rejects.toThrow('Compiled channel route GET /compiled is missing from "channels/status.ts".');
  });
});
