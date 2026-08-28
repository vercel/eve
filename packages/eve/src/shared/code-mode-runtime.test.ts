import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import { runCodeMode } from "#compiled/experimental-ai-sdk-code-mode/index.js";

describe("code-mode runtime settlement", () => {
  it("does not keep the process alive with a losing deadline timer", async () => {
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    await expect(
      runCodeMode({
        js: "return await tools.fast({});",
        options: { executionPolicy: { timeoutMs: 10_000 } },
        toolExecutionOptions: { messages: [], toolCallId: "fast-settlement" },
        tools: {
          fast: tool({ execute: async () => ({}), inputSchema, outputSchema }),
        },
      }),
    ).resolves.toEqual({});
  });

  it("waits for started sibling calls before a failed program rejects", async () => {
    const order: string[] = [];
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    const run = runCodeMode({
      js: "return await Promise.all([tools.fail({}), tools.slow({})]);",
      options: { executionPolicy: { timeoutMs: 1_000 } },
      toolExecutionOptions: { messages: [], toolCallId: "settlement" },
      tools: {
        fail: tool({
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("failed");
          },
          inputSchema,
          outputSchema,
        }),
        slow: tool({
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("slow-settled");
            return {};
          },
          inputSchema,
          outputSchema,
        }),
      },
    });

    await expect(run).rejects.toThrow();
    expect(order).toEqual(["slow-settled"]);
  });
});
