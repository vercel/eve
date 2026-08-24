import { describe, expect, it } from "vitest";

import {
  extensionRegistrationForSourceId,
  type CompiledExtensionRegistration,
  type CompiledExtensionRegistrationIndex,
} from "#compiler/extension-registrations.js";

describe("extensionRegistrationForSourceId", () => {
  it("uses the contribution path when inherited and local mounts share a namespace", () => {
    const inherited = registration("/app/agent/extensions/crm.ts", "/packages/parent/extension");
    const local = registration(
      "/app/agent/subagents/child/extensions/crm.ts",
      "/packages/child/extension",
    );
    const index: CompiledExtensionRegistrationIndex = {
      agentRootByNodeId: new Map([["child", "/app/agent/subagents/child"]]),
      byMountSourceIdByNodeId: new Map(),
      byNamespaceByNodeId: new Map([["child", new Map([["crm", [inherited, local]]])]]),
      registrations: [inherited, local],
    };

    expect(
      extensionRegistrationForSourceId(
        "ext:crm:tools/search",
        "../../../../../packages/parent/extension/tools/search.ts",
        "child",
        index,
      ),
    ).toBe(inherited);
  });
});

function registration(id: string, sourceRoot: string): CompiledExtensionRegistration {
  return {
    id,
    mount: {
      mountLogicalPath: "extensions/crm.ts",
      mountSourceId: "extensions/crm",
      namespace: "crm",
      packageName: "@acme/crm",
      packageNamespace: "acme-crm",
      sourceRoot,
    },
  };
}
