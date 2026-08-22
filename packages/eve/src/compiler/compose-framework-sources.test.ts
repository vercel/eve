import { describe, expect, it } from "vitest";

import { composeFrameworkSources } from "#compiler/compose-framework-sources.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

describe("composeFrameworkSources", () => {
  it("uses application tools and sandbox modules for matching canonical slots", () => {
    const result = composeFrameworkSources({
      isRoot: true,
      manifest: createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        sandbox: createModuleSourceRef({ logicalPath: "sandbox/sandbox.ts" }),
        tools: [createModuleSourceRef({ logicalPath: "tools/bash.ts" })],
      }),
      nodeId: "root",
      registry: frameworkAgentSourceRegistry,
    });

    expect(
      result.manifest.tools.find((tool) => tool.logicalPath === "tools/bash.ts")?.sourceId,
    ).toBe("tools/bash.ts");
    expect(result.manifest.sandbox?.sourceId).toBe("sandbox/sandbox.ts");
    expect(result.bindings["eve.framework-defaults:tools/bash.ts"]).toBeUndefined();
    expect(result.bindings["eve.framework-defaults:sandbox.ts"]).toBeUndefined();
  });

  it("binds non-overridden defaults to their programmatic owners", () => {
    const result = composeFrameworkSources({
      isRoot: false,
      manifest: createAgentSourceManifest({
        agentId: "child",
        agentRoot: "/app/agent/subagents/child",
        appRoot: "/app",
      }),
      nodeId: "subagents/child",
      registry: frameworkAgentSourceRegistry,
    });

    expect(result.manifest.tools.map((tool) => tool.logicalPath)).toEqual([
      "tools/bash.ts",
      "tools/connection_search.ts",
      "tools/read_file.ts",
      "tools/todo.ts",
      "tools/web_fetch.ts",
      "tools/write_file.ts",
    ]);
    expect(result.manifest.sandbox?.logicalPath).toBe("sandbox.ts");
    expect(result.bindings["eve.framework-defaults:tools/bash.ts"]).toEqual({
      backing: {
        kind: "programmatic",
        moduleId: "tools/bash.ts",
        registryId: "eve.framework-defaults",
      },
      logicalPath: "tools/bash.ts",
      owner: { feature: "eve.framework-defaults", kind: "framework" },
    });
  });
});
