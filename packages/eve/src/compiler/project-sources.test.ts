import { describe, expect, it } from "vitest";

import {
  projectAgentSources,
  qualifyExtensionContributionLogicalPath,
} from "#compiler/project-sources.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";

describe("qualifyExtensionContributionLogicalPath", () => {
  it.each([
    ["channels/webhook.ts", "channels/crm__webhook.ts"],
    ["connections/api.ts", "connections/crm__api.ts"],
    ["hooks/audit.ts", "hooks/crm__audit.ts"],
    ["instructions.md", "instructions/crm.md"],
    ["instructions/policy.md", "instructions/crm__policy.md"],
    ["schedules/sync.ts", "schedules/crm__sync.ts"],
    ["skills/triage/SKILL.md", "skills/crm__triage/SKILL.md"],
    ["subagents/reviewer/agent.ts", "subagents/crm__reviewer/agent.ts"],
    ["tools/search.ts", "tools/crm__search.ts"],
  ])("scopes %s", (logicalPath, expected) => {
    expect(qualifyExtensionContributionLogicalPath(logicalPath, "crm")).toBe(expected);
  });

  it.each(["agent.ts", "instrumentation/otel.ts", "memory.ts", "sandbox.ts", "lib/http.ts"])(
    "rejects unscopable slot %s",
    (logicalPath) => {
      expect(() => qualifyExtensionContributionLogicalPath(logicalPath, "crm")).toThrow(
        `Extension source slot "${logicalPath}" cannot be namespace-scoped.`,
      );
    },
  );

  it("derives extension identity from the owning node and mount name", () => {
    for (const mountPath of ["extensions/crm.ts", "extensions/crm/extension.ts"]) {
      const reviewer = createLocalSubagentSourceRef({
        entryPath: "/extension/subagents/reviewer",
        logicalPath: "subagents/reviewer",
        manifest: createAgentSourceManifest({
          agentRoot: "/extension/subagents/reviewer",
          appRoot: "/package",
        }),
        rootPath: "/extension/subagents/reviewer",
        subagentId: "reviewer",
      });
      const extensionManifest = createAgentSourceManifest({
        agentRoot: "/extension",
        appRoot: "/package",
        subagents: [reviewer],
        tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
      });
      const manifest = createAgentSourceManifest({
        agentRoot: "/app/agent/subagents/research",
        appRoot: "/app",
        extensions: [createModuleSourceRef({ logicalPath: mountPath })],
        resolvedExtensions: [
          {
            namespace: "crm",
            specifier: "@acme/crm",
            packageName: "@acme/crm",
            packageRoot: "/package",
            sourceRoot: "/extension",
            manifest: extensionManifest,
            overrides: createAgentSourceManifest({
              agentRoot: "/app/agent/subagents/research/extensions/crm",
              appRoot: "/app",
              subagents: [
                {
                  ...reviewer,
                  entryPath: "/app/agent/subagents/research/extensions/crm/subagents/reviewer",
                  rootPath: "/app/agent/subagents/research/extensions/crm/subagents/reviewer",
                },
              ],
            }),
            externalDependencies: [],
          },
        ],
      });
      const projected = projectAgentSources({
        externalDependencies: [],
        manifest,
        nodeId: "research",
        nodePath: "subagents/research",
      });
      expect(projected.candidates.find((entry) => entry.owner.kind === "extension")?.owner).toEqual(
        {
          kind: "extension",
          mountId: "subagents/research/extensions/crm",
          namespace: "crm",
          packageName: "@acme/crm",
        },
      );
      expect(projected.subagents.map(({ nodePath, owner }) => ({ nodePath, owner }))).toEqual([
        {
          nodePath: "subagents/research/extensions/crm/subagents/reviewer",
          owner: {
            kind: "extension",
            mountId: "subagents/research/extensions/crm",
            namespace: "crm",
            packageName: "@acme/crm",
          },
        },
        {
          nodePath: "subagents/research/extensions/crm/subagents/reviewer",
          owner: { kind: "application" },
        },
      ]);
    }
  });

  it("applies the selected extension projector to canonical path overrides", () => {
    const extensionManifest = createAgentSourceManifest({
      agentRoot: "/extension",
      appRoot: "/package",
      configModule: createModuleSourceRef({ logicalPath: "custom-agent.ts" }),
    });
    const manifest = createAgentSourceManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      resolvedExtensions: [
        {
          namespace: "crm",
          specifier: "@acme/crm",
          packageName: "@acme/crm",
          packageRoot: "/package",
          sourceRoot: "/extension",
          manifest: extensionManifest,
          externalDependencies: [],
        },
      ],
    });

    expect(() =>
      projectAgentSources({ externalDependencies: [], manifest, nodeId: "root", nodePath: "" }),
    ).toThrow('Extension source slot "agent.ts" cannot be namespace-scoped.');
  });
});
