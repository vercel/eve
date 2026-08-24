import { describe, expect, it } from "vitest";

import { compileConnectionDefinition } from "#compiler/normalize-connection.js";

describe("compileConnectionDefinition", () => {
  it("serializes normalized authorization, approval, and header presence", async () => {
    const definition = await compileConnectionDefinition(
      {
        connectionName: "crm",
        logicalPath: "connections/crm.ts",
        sourceId: "opaque:connection",
        sourceKind: "module",
      },
      {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "opaque:connection",
            registryId: "normalize-connection-test",
            revision: "v1",
          },
          logicalPath: "connections/crm.ts",
          owner: { kind: "application" },
        },
        moduleLoader: {
          async load() {
            return {
              default: {
                approval: () => "user-approval",
                auth: { getToken: async () => ({ token: "token" }) },
                description: "CRM connection.",
                headers: { "X-Client": "eve" },
                url: "https://crm.example/mcp",
              },
            };
          },
        },
      },
    );

    expect(definition).toEqual(
      expect.objectContaining({
        hasApproval: true,
        hasAuthorization: true,
        hasHeaders: true,
      }),
    );
  });
});
