import { jsonSchema, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { createCodeModeRuntimeTool } from "#shared/code-mode-runtime.js";

async function runCodeMode(tools: ToolSet, js: string) {
  const codeMode = await createCodeModeRuntimeTool({ hostTools: tools });
  if (codeMode.execute === undefined) throw new Error("code_mode has no executor");
  return await codeMode.execute({ js }, { messages: [], toolCallId: "settlement" } as never);
}

describe("code-mode runtime settlement", () => {
  it("has no ambient host capabilities", async () => {
    await expect(
      runCodeMode(
        {},
        `return {
          fetch: typeof fetch,
          process: typeof process,
          require: typeof require,
          setTimeout: typeof setTimeout,
        };`,
      ),
    ).resolves.toEqual({
      fetch: "undefined",
      process: "undefined",
      require: "undefined",
      setTimeout: "undefined",
    });
  });

  it("does not keep the process alive with a losing deadline timer", async () => {
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    await expect(
      runCodeMode(
        {
          fast: tool({ execute: async () => ({}), inputSchema, outputSchema }),
        },
        "return await tools.fast({});",
      ),
    ).resolves.toEqual({});
  });

  it("waits for started sibling calls before a failed program rejects", async () => {
    const order: string[] = [];
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    const run = runCodeMode(
      {
        fail: tool({
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("failed");
          },
          inputSchema,
          outputSchema,
        }),
        slow: tool({
          execute: async (_input, options) => {
            options.abortSignal?.addEventListener("abort", () => order.push("slow-aborted"), {
              once: true,
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("slow-settled");
            return {};
          },
          inputSchema,
          outputSchema,
        }),
      },
      "return await Promise.all([tools.fail({}), tools.slow({})]);",
    );

    await expect(run).rejects.toThrow();
    expect(order).toEqual(["slow-aborted", "slow-settled"]);
  });

  it("rejects detached host work before starting the host call", async () => {
    const order: string[] = [];
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    const run = runCodeMode(
      {
        slow: tool({
          execute: async (_input, options) => {
            options.abortSignal?.addEventListener("abort", () => order.push("slow-aborted"), {
              once: true,
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("slow-settled");
            return {};
          },
          inputSchema,
          outputSchema,
        }),
      },
      "void tools.slow({}); return {};",
    );

    await expect(run).rejects.toThrow(/unawaited|still in flight|detached/iu);
    expect(order).toEqual([]);
  });
});
