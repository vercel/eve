import { describe, expect, it } from "vitest";

import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeSubagentNode } from "#runtime/types.js";

function subagent(tool?: boolean): ResolvedRuntimeSubagentNode {
  return {
    description: "Research difficult questions.",
    kind: "subagent",
    logicalPath: "subagents/researcher",
    name: "researcher",
    nodeId: "subagents/researcher",
    sourceId: "subagents/researcher",
    sourceKind: "module",
    tool,
  };
}

describe("createRuntimeSubagentRegistry", () => {
  it("registers a tool-disabled subagent without preparing a model tool", () => {
    const registry = createRuntimeSubagentRegistry({ subagents: [subagent(false)] });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
    expect(registry.subagentsByNodeId.has("subagents/researcher")).toBe(true);
  });

  it("applies a same-named disabled tool without removing the subagent", () => {
    const registry = createRuntimeSubagentRegistry({
      disabledToolNames: ["researcher"],
      subagents: [subagent()],
    });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
  });

  it("allows an authored wrapper to use a tool-disabled subagent name", () => {
    const registry = createRuntimeSubagentRegistry({
      reservedToolNames: ["researcher"],
      subagents: [subagent(false)],
    });

    expect(registry.preparedTools).toEqual([]);
    expect(registry.subagentsByName.has("researcher")).toBe(true);
  });

  it("rejects an authored tool that collides with a model-visible subagent", () => {
    expect(() =>
      createRuntimeSubagentRegistry({
        reservedToolNames: ["researcher"],
        subagents: [subagent()],
      }),
    ).toThrow('Subagent "researcher" collides with another runtime-visible tool name.');
  });
});
