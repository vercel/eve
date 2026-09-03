import { describe, expect, it } from "vitest";

import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";

const definition: CompiledToolDefinition = {
  description: "Deploy a project.",
  exportName: undefined,
  hasExecute: true,
  hasModelOutputProjection: false,
  inputSchema: { type: "object" },
  logicalPath: "tools/deploy.ts",
  name: "deploy",
  requiresApproval: false,
  sourceId: "tools/deploy.ts",
  sourceKind: "module",
};

function moduleMap(value: unknown): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: { [definition.sourceId]: { default: value } },
      },
    },
  } as CompiledModuleMap;
}

describe("resolveToolDefinition", () => {
  it("reattaches the authored label start callback callback", async () => {
    const resolved = await resolveToolDefinition(
      definition,
      moduleMap({
        label: {
          start: (input: { environment: string }) => `Deploy to ${input.environment}`,
        },
        description: definition.description,
        execute: () => null,
        inputSchema: { type: "object" },
      }),
      undefined,
      { kind: "application" },
    );

    expect(resolved.label?.start?.({ environment: "production" })).toBe("Deploy to production");
  });
});
