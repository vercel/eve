import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileFromMemory } from "../src/compiler/compile-from-memory.js";
import { disableTool } from "../src/public/definitions/tool.js";
import { resolveRuntimeAgentGraph } from "../src/runtime/resolve-agent-graph.js";

describe("resolveRuntimeAgentGraph", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hydrates the compiler-selected framework graph without runtime catalogs", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      name: "workspace-agent",
    });

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const names = graph.root.turnAgent.tools.map((tool) => tool.name);

    expect(graph.root.nodeId).toBe("__root__");
    expect(graph.root.sandboxRegistry.sandbox.definition.backend.name).toBe("vercel");
    expect(names).toEqual(manifest.tools.map((tool) => tool.name));
    expect(names).toContain("web_search");
    expect(graph.root.agent.tools.every((tool) => tool.owner.kind === "framework")).toBe(true);
  });

  it("uses authored replacement and disable decisions already recorded by the compiler", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({ default: disableTool() }),
          logicalPath: "tools/web_fetch.ts",
        },
      ],
      tools: [
        {
          description: "Application-owned shell.",
          execute: (input) => input,
          name: "bash",
        },
      ],
    });

    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const bash = graph.root.turnAgent.tools.filter((tool) => tool.name === "bash");

    expect(bash).toHaveLength(1);
    expect(bash[0]).toMatchObject({
      description: "Application-owned shell.",
      owner: { kind: "application" },
    });
    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).not.toContain("web_fetch");
    expect(manifest.sourceComposition.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "shadowed",
          winnerSourceId: expect.stringContaining("tools/bash.ts"),
        }),
        expect.objectContaining({
          kind: "disabled",
          source: expect.objectContaining({ logicalPath: "tools/web_fetch.ts" }),
        }),
      ]),
    );
  });

  it("rejects module maps that diverge from the manifest bindings", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const root = moduleMap.nodes.__root__!;
    const [removed, ...remaining] = Object.entries(root.modules);
    if (removed === undefined) throw new Error("Expected compiled bindings.");

    await expect(
      resolveRuntimeAgentGraph({
        manifest,
        moduleMap: { nodes: { __root__: { modules: Object.fromEntries(remaining) } } },
      }),
    ).rejects.toThrow("do not match its bindings");
  });
});
