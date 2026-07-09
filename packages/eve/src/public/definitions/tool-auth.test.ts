import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { defineClientTool, defineTool } from "#public/definitions/tool.js";

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

describe("defineClientTool", () => {
  it("defines a client-side tool with input request metadata and a fixed output schema", () => {
    const tool = defineClientTool({
      description: "Ask which plan to apply.",
      inputSchema: z.object({ accountId: z.string() }),
      inputRequest: {
        allowFreeform: false,
        display: "select",
        options: ({ accountId }) => [
          { id: "basic", label: `Basic for ${accountId}` },
          { id: "pro", label: "Pro" },
        ],
        prompt: ({ accountId }) => `Choose a plan for ${accountId}.`,
      },
    });

    expect((tool as { execute?: unknown }).execute).toBeUndefined();
    const prompt = tool.inputRequest.prompt;
    const options = tool.inputRequest.options;

    expect(typeof prompt).toBe("function");
    expect(typeof options).toBe("function");
    if (typeof prompt !== "function" || typeof options !== "function") {
      throw new Error("Expected dynamic input request metadata.");
    }
    expect(prompt({ accountId: "acct_1" })).toBe("Choose a plan for acct_1.");
    expect(options({ accountId: "acct_1" })).toEqual([
      { id: "basic", label: "Basic for acct_1" },
      { id: "pro", label: "Pro" },
    ]);
    expect(tool.outputSchema).toEqual({
      additionalProperties: false,
      properties: {
        optionId: { type: "string" },
        status: { enum: ["answered", "ignored"], type: "string" },
        text: { type: "string" },
      },
      required: ["status"],
      type: "object",
    });
  });
});
