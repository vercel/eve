import { describe, expect, it } from "vitest";
import { defineTool } from "#tools/definition.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { resolveToolDefinition } from "#runtime/resolve-tool.js";

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
