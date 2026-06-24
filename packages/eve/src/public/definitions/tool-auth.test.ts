import { describe, expect, it } from "vitest";

import { defineTool } from "#public/definitions/tool.js";

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

    expect(() => defineTool(definition as never)).toThrow(/"auth" field is no longer supported/);
  });
});
