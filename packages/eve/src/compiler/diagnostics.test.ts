import { expect, it } from "vitest";

import { createCodeModeUntypedToolDiagnostics } from "#compiler/diagnostics.js";
import type { CompiledToolDefinition } from "#compiler/manifest.js";
import type { AgentModuleBinding, AgentSourceOwner } from "#compiler/source-graph.js";

it("warns about untyped tools the application authors, not an extension's or eve's own", () => {
  const owners: Record<string, AgentSourceOwner> = {
    lookup: { kind: "application" },
    crm__lookup: {
      kind: "extension",
      mountId: "extensions/crm",
      namespace: "crm",
      packageName: "@acme/crm",
    },
    no_reply: { feature: "eve:defaults", kind: "framework" },
  };
  const names = Object.keys(owners);

  const diagnostics = createCodeModeUntypedToolDiagnostics({
    bindings: Object.fromEntries(
      names.map((name): [string, AgentModuleBinding] => [
        name,
        {
          backing: { kind: "programmatic", moduleId: name, registryId: "test", revision: "v1" },
          logicalPath: `tools/${name}.ts`,
          owner: owners[name]!,
        },
      ]),
    ),
    nodeId: "__root__",
    tools: names.map((name): CompiledToolDefinition => ({
      description: `${name} description`,
      hasExecute: true,
      hasModelOutputProjection: false,
      inputSchema: { type: "object" },
      logicalPath: `tools/${name}.ts`,
      name,
      requiresApproval: false,
      sourceId: name,
      sourceKind: "module",
    })),
  });

  expect(diagnostics.map(({ sources }) => sources[0]?.logicalPath)).toEqual(["tools/lookup.ts"]);
});
