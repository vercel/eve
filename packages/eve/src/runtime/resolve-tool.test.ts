import { describe, expect, it } from "vitest";

import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";
import { defineTool } from "#tools/definition.js";

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

    expect(resolved.activity?.start?.({ environment: "production" })).toBe("Deploy to production");
  });
});

describe("authored tool approval keys", () => {
  it("validates and reattaches the scoped key callback", async () => {
    const authored = defineTool({
      description: "Scoped write",
      inputSchema: { type: "object" },
      approvalKey: (input) => `write:${input.scope}`,
      execute: () => null,
    });
    expect(normalizeToolDefinition(authored, "Invalid tool").kind).toBe("tool");
    const resolved = await resolveToolDefinition(
      {
        description: authored.description,
        name: "write",
        inputSchema: { type: "object" },
        logicalPath: "tools/write.ts",
        sourceId: "tools/write.ts",
        sourceKind: "module",
        hasExecute: true,
        requiresApproval: false,
        hasModelOutputProjection: false,
      },
      { nodes: { __root__: { modules: { "tools/write.ts": { default: authored } } } } },
      undefined,
      { kind: "application" },
    );
    expect(resolved.approvalKey?.({ scope: "repo" })).toBe("write:repo");
    expect(() =>
      normalizeToolDefinition({ ...authored, approvalKey: "invalid" }, "Invalid tool"),
    ).toThrow();
  });
});
