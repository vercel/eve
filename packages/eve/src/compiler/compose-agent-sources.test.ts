import { describe, expect, it } from "vitest";

import { composeAgentSources, getSubagentSourceOrigin } from "#compiler/compose-agent-sources.js";
import {
  createAgentSourceManifest,
  createConnectionSourceRef,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

describe("composeAgentSources", () => {
  it("uses application channels, tools, and sandbox modules for matching canonical slots", () => {
    const result = composeAgentSources({
      isRoot: true,
      manifest: createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        channels: [createModuleSourceRef({ logicalPath: "channels/eve.ts" })],
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
    expect(
      result.manifest.channels.find((channel) => channel.logicalPath === "channels/eve.ts")
        ?.sourceId,
    ).toBe("channels/eve.ts");
    expect(result.bindings["eve.framework-root:channels/eve.ts"]).toBeUndefined();
    expect(result.bindings["eve.framework-defaults:tools/bash.ts"]).toBeUndefined();
    expect(result.bindings["eve.framework-defaults:sandbox.ts"]).toBeUndefined();
  });

  it("binds non-overridden defaults to their programmatic owners", () => {
    const result = composeAgentSources({
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
      "tools/load_skill.ts",
      "tools/read_file.ts",
      "tools/todo.ts",
      "tools/web_fetch.ts",
      "tools/web_search.ts",
      "tools/write_file.ts",
    ]);
    expect(result.manifest.channels).toEqual([]);
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

  it("projects every extension primitive before selecting override and application winners", () => {
    const extensionRoot = "/packages/crm/extension";
    const overrideRoot = "/app/agent/extensions/crm";
    const extensionManifest = createAgentSourceManifest({
      agentRoot: extensionRoot,
      appRoot: "/packages/crm",
      channels: [createModuleSourceRef({ logicalPath: "channels/webhooks/events.ts" })],
      connections: [
        createConnectionSourceRef({ connectionName: "api", logicalPath: "connections/api.ts" }),
      ],
      hooks: [createModuleSourceRef({ logicalPath: "hooks/session/start.ts" })],
      instructions: [
        {
          definition: { content: "CRM instructions", role: "system" },
          logicalPath: "instructions.md",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      ],
      schedules: [createModuleSourceRef({ logicalPath: "schedules/daily/sync.ts" })],
      skills: [createModuleSourceRef({ logicalPath: "skills/research.ts" })],
      tools: [
        createModuleSourceRef({ logicalPath: "tools/search.ts" }),
        createModuleSourceRef({ logicalPath: "tools/list.ts" }),
      ],
    });
    const overrides = createAgentSourceManifest({
      agentRoot: overrideRoot,
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
    });
    const result = composeAgentSources({
      isRoot: true,
      manifest: createAgentSourceManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        resolvedExtensions: [
          {
            externalDependencies: ["@acme/sdk"],
            manifest: extensionManifest,
            namespace: "crm",
            overrides,
            packageName: "@acme/crm",
            packageRoot: "/packages/crm",
            sourceRoot: extensionRoot,
            specifier: "@acme/crm",
          },
        ],
        tools: [createModuleSourceRef({ logicalPath: "tools/crm__list.ts" })],
      }),
      nodeId: "root",
      registry: frameworkAgentSourceRegistry,
    });

    expect(result.manifest.channels.map((source) => source.logicalPath)).toContain(
      "channels/crm__webhooks/events.ts",
    );
    expect(result.manifest.connections).toEqual([
      expect.objectContaining({
        connectionName: "crm__api",
        logicalPath: "connections/crm__api.ts",
      }),
    ]);
    expect(result.manifest.hooks.map((source) => source.logicalPath)).toContain(
      "hooks/crm__session/start.ts",
    );
    expect(result.manifest.instructions.map((source) => source.logicalPath)).toContain(
      "instructions/crm__instructions.md",
    );
    expect(result.manifest.schedules.map((source) => source.logicalPath)).toContain(
      "schedules/crm__daily/sync.ts",
    );
    expect(result.manifest.skills.map((source) => source.logicalPath)).toContain(
      "skills/crm__research.ts",
    );
    expect(result.manifest.tools.map((source) => [source.logicalPath, source.sourceId])).toEqual(
      expect.arrayContaining([
        ["tools/crm__list.ts", "tools/crm__list.ts"],
        ["tools/crm__search.ts", "ext-override:crm:tools/search.ts"],
      ]),
    );
    expect(result.bindings["ext:crm:tools/list.ts"]).toBeUndefined();
    expect(result.bindings["ext-override:crm:tools/search.ts"]).toEqual({
      backing: {
        externalDependencies: ["@acme/sdk"],
        kind: "filesystem",
        sourcePath: "/app/agent/extensions/crm/tools/search.ts",
      },
      logicalPath: "tools/crm__search.ts",
      owner: { kind: "application" },
    });
  });

  it("projects extension subagents and preserves their source ownership", () => {
    const childRoot = "/packages/crm/extension/subagents/reviewer";
    const child = createLocalSubagentSourceRef({
      entryPath: childRoot,
      logicalPath: "subagents/reviewer",
      manifest: createAgentSourceManifest({
        agentRoot: childRoot,
        appRoot: "/packages/crm",
        configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      }),
      rootPath: childRoot,
      subagentId: "reviewer",
    });
    const result = composeAgentSources({
      isRoot: true,
      manifest: createAgentSourceManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        resolvedExtensions: [
          {
            externalDependencies: [],
            manifest: createAgentSourceManifest({
              agentRoot: "/packages/crm/extension",
              appRoot: "/packages/crm",
              subagents: [child],
            }),
            namespace: "crm",
            packageName: "@acme/crm",
            packageRoot: "/packages/crm",
            sourceRoot: "/packages/crm/extension",
            specifier: "@acme/crm",
          },
        ],
      }),
      nodeId: "root",
      registry: frameworkAgentSourceRegistry,
    });

    const projected = result.manifest.subagents[0]!;
    expect(projected).toMatchObject({
      logicalPath: "subagents/crm__reviewer",
      sourceId: "ext:crm:subagents/reviewer",
      subagentId: "crm__reviewer",
    });
    expect(getSubagentSourceOrigin(projected)).toMatchObject({
      layer: "extension-package",
      owner: { kind: "extension", namespace: "crm", packageName: "@acme/crm" },
    });
  });
});
