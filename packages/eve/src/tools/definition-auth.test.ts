import { describe, expect, expectTypeOf, it } from "vitest";

import { z } from "zod";

import { defineTool } from "#tools/definition.js";

describe("defineTool auth field", () => {
  it("rejects top-level auth at runtime", () => {
    const definition = {
      description: "Static-token tool.",
      inputSchema: { type: "object" },
      auth: {
        async getToken(): Promise<{ token: string }> {
          return { token: "static" };
        },
      },
      execute: () => null,
    };

    expect(() => defineTool(definition)).toThrow(/"auth" field is no longer supported/);
  });
});

describe("defineTool approvalKey", () => {
  it("infers readonly input from the schema", () => {
    const definition = defineTool({
      description: "Scoped write",
      inputSchema: z.object({ scope: z.string() }),
      approvalKey(input) {
        expectTypeOf(input).toEqualTypeOf<Readonly<{ scope: string }>>();
        return `write:${input.scope}`;
      },
      execute: (input) => input.scope,
    });
    expect(definition.approvalKey?.({ scope: "repo" })).toBe("write:repo");
  });

  it("rejects the removed execution option", () => {
    const definition = {
      description: "Scoped background write",
      execution: "blocking",
      inputSchema: z.object({ scope: z.string() }),
      execute: async () => null,
    };
    expect(() => defineTool(definition)).toThrow('defineTool: "execution" is no longer supported.');
  });
});
