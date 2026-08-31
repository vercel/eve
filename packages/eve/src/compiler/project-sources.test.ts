import { describe, expect, it } from "vitest";

import {
  projectAgentSources,
  qualifyExtensionContributionLogicalPath,
} from "#compiler/project-sources.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";

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

  it.each(["agent.ts", "instrumentation.ts", "memory.ts", "sandbox.ts", "lib/http.ts"])(
    "rejects unscopable slot %s",
    (logicalPath) => {
      expect(() => qualifyExtensionContributionLogicalPath(logicalPath, "crm")).toThrow(
        `Extension source slot "${logicalPath}" cannot be namespace-scoped.`,
      );
    },
  );

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
      projectAgentSources({ externalDependencies: [], manifest, nodeId: "root" }),
    ).toThrow('Extension source slot "agent.ts" cannot be namespace-scoped.');
  });
});
