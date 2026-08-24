import { describe, expect, it } from "vitest";

import { compileToolEntry } from "#compiler/normalize-tool.js";

describe("compileToolEntry", () => {
  it("serializes normalized runtime-behavior flags", async () => {
    const definition = await compileToolEntry(
      {
        logicalPath: "tools/search.ts",
        sourceId: "opaque:search",
        sourceKind: "module",
      },
      {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "opaque:search",
            registryId: "normalize-tool-test",
            revision: "v1",
          },
          logicalPath: "tools/search.ts",
          owner: { kind: "application" },
        },
        moduleLoader: {
          async load() {
            return {
              default: {
                approval: () => "user-approval",
                auth: { getToken: async () => ({ token: "token" }) },
                description: "Search records.",
                execute: () => null,
                inputSchema: { type: "object" },
                toModelOutput: () => ({ type: "text", value: "done" }),
              },
            };
          },
        },
      },
    );

    expect(definition).toEqual({
      definition: expect.objectContaining({
        hasAuth: true,
        hasExecute: true,
        hasModelOutputProjection: true,
        requiresApproval: true,
      }),
      kind: "tool",
    });
  });
});
