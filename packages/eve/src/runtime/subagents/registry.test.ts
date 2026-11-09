import { describe, expect, it } from "vitest";

import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeSubagentNode } from "#runtime/types.js";

function subagent(tool?: boolean, name = "researcher"): ResolvedRuntimeSubagentNode {
  return {
    description: "Research difficult questions.",
    kind: "subagent",
    logicalPath: `subagents/${name}`,
    name,
    nodeId: `subagents/${name}`,
    sourceId: `subagents/${name}`,
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

  it.each([true, false])("rejects a subagent in eve's namespace with tool %s", (tool) => {
    expect(() =>
      createRuntimeSubagentRegistry({ subagents: [subagent(tool, "eve__task_wait")] }),
    ).toThrow(
      'Subagent "subagents/eve__task_wait" uses the reserved name "eve__task_wait". Rename its path; eve reserves the "eve" namespace for its built-in tools.',
    );
  });

  it("lets a model-visible subagent take a built-in tool's former name", () => {
    const registry = createRuntimeSubagentRegistry({ subagents: [subagent(true, "task_wait")] });

    expect(registry.preparedTools.map((tool) => tool.name)).toEqual(["task_wait"]);
  });
});
