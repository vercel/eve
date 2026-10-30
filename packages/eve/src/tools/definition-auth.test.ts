import { describe, expect, it } from "vitest";

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
  it("rejects the removed field with approval policy guidance", () => {
    const definition = {
      description: "Scoped write",
      inputSchema: z.object({ scope: z.string() }),
      approvalKey: () => "write:repo",
      execute: () => "ok",
    };
    expect(() => defineTool(definition)).toThrow(/approvalKey.*approval policy/);
  });
});
