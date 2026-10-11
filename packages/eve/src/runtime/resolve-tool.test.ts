import { describe, expect, it, vi } from "vitest";

import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { toolResultFrom } from "#public/tools/result.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import { defineTool } from "#tools/definition.js";
import { sleep } from "#tools/provided/sleep.js";
import { noReply } from "#tools/provided/no-reply.js";
import { isFrameworkTool } from "#tools/provided/framework-tool.js";

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
  it.each([
    { tool: sleep(), action: "sleep", workflow: true },
    { tool: noReply(), action: "no_reply", workflow: false },
  ])(
    "marks $action after an author spreads and renames the provided definition",
    async ({ tool, workflow }) => {
      const compiled = { ...definition, description: tool.description };
      if (workflow)
        compiled.behavior = {
          availability: [],
          handling: { kind: "workflow-tool", entryPoint: "execute", workflowId: "sleep-workflow" },
        };
      const resolved = await resolveToolDefinition(compiled, moduleMap({ ...tool }), undefined, {
        kind: "application",
      });
      expect(resolved.name).toBe("deploy");
      expect(isFrameworkTool(resolved)).toBe(true);
    },
  );
  it("reattaches authored label callbacks", async () => {
    const resolved = await resolveToolDefinition(
      definition,
      moduleMap({
        label: {
          start: (input: { environment: string }) => `Deploy to ${input.environment}`,
          complete: (_input: { environment: string }, output: { url: string }) =>
            `Deployed to ${output.url}`,
          delta: (_input: { environment: string }, partial: { phase: string }) => partial.phase,
        },
        description: definition.description,
        execute: () => null,
        inputSchema: { type: "object" },
      }),
      undefined,
      { kind: "application" },
    );

    expect(resolved.label?.start?.({ environment: "production" })).toBe("Deploy to production");
    expect(
      resolved.label?.complete?.({ environment: "production" }, { url: "https://example.com" }),
    ).toBe("Deployed to https://example.com");
    expect(resolved.label?.delta?.({ environment: "production" }, { phase: "Uploading" })).toBe(
      "Uploading",
    );
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

describe("toolResultFrom identity for resolved tools", () => {
  it("matches every name one shared definition is mounted under without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shared = defineTool({
      description: "Search the workspace with a shared definition.",
      execute: () => null,
      inputSchema: { type: "object" },
    });
    const mounts = [
      { name: "code__search", sourceId: "tools/code__search.ts" },
      { name: "search", sourceId: "subagents/worker/tools/search.ts" },
    ];
    for (const mount of mounts) {
      await resolveToolDefinition(
        { ...definition, description: shared.description, logicalPath: mount.sourceId, ...mount },
        {
          nodes: { __root__: { modules: { [mount.sourceId]: { default: shared } } } },
        } as CompiledModuleMap,
        undefined,
        { kind: "application" },
      );
    }

    expect(warn).not.toHaveBeenCalled();
    for (const { name } of mounts) {
      expect(toolResultFrom(toolResult(name), shared)?.toolName).toBe(name);
    }
    expect(toolResultFrom(toolResult("other"), shared)).toBeUndefined();
    warn.mockRestore();
  });
});

function toolResult(toolName: string): RuntimeActionResult {
  return { callId: "call_1", kind: "tool-result", output: null, toolName };
}
