import { jsonSchema, tool, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  CODE_MODE_TASK_LAUNCH_LIMIT,
  createCodeModeRuntimeTool,
} from "#shared/code-mode-runtime.js";

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

  it("caps task launchers per program", async () => {
    let launches = 0;
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    const task = tool({
      execute: async () => {
        launches += 1;
        return {};
      },
      inputSchema,
      outputSchema,
    });
    const codeMode = await createCodeModeRuntimeTool({
      hostTools: { task },
      taskLaunchers: new Map([
        [
          "task",
          {
            execute: async () => {
              launches += 1;
              return {};
            },
            mode: "local",
            prepare: async () => {},
            preview: () => ({}),
            reserve: () => {},
            rollback: async () => {},
          },
        ],
      ]),
    });
    if (codeMode.execute === undefined) throw new Error("code_mode has no executor");
    const run = codeMode.execute(
      {
        js: `for (let i = 0; i < ${CODE_MODE_TASK_LAUNCH_LIMIT + 1}; i++) await tools.task({}); return {};`,
      },
      { messages: [], toolCallId: "task-limit" } as never,
    );

    await expect(run).rejects.toThrow(`at most ${CODE_MODE_TASK_LAUNCH_LIMIT}`);
    expect(launches).toBe(0);
  });

  it("rolls back launches that settle after cancellation", async () => {
    const controller = new AbortController();
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    let releaseLate: (() => void) | undefined;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let launched = 0;
    const rolledBack: string[] = [];
    const task = tool({ execute: async () => ({}), inputSchema, outputSchema });
    const codeMode = await createCodeModeRuntimeTool({
      hostTools: { task },
      taskLaunchers: new Map([
        [
          "task",
          {
            async execute(_input, options) {
              launched += 1;
              if (launched === 2) await late;
              return { id: options.toolCallId };
            },
            mode: "local",
            prepare: async () => {},
            preview: (_input, options) => ({ id: options.toolCallId }),
            reserve: () => {},
            rollback: async (_cause, options) => {
              rolledBack.push(options.toolCallId);
            },
          },
        ],
      ]),
    });
    if (codeMode.execute === undefined) throw new Error("code_mode has no executor");
    const run = codeMode.execute(
      { js: "return await Promise.all([tools.task({}), tools.task({})]);" },
      { abortSignal: controller.signal, messages: [], toolCallId: "cancel-staged" } as never,
    );
    await vi.waitFor(() => expect(launched).toBe(2));
    controller.abort(new Error("cancelled"));
    if (releaseLate === undefined) throw new Error("Late launch resolver was not initialized.");
    releaseLate();

    await expect(run).rejects.toThrow("cancelled");
    expect(rolledBack).toEqual(["cancel-staged:tool-2"]);
  });

  it("rolls back staged launches when an actual receipt differs from its preview", async () => {
    const inputSchema = jsonSchema({ type: "object" });
    const outputSchema = jsonSchema({ type: "object" });
    const rolledBack: string[] = [];
    const task = tool({ execute: async () => ({}), inputSchema, outputSchema });
    const codeMode = await createCodeModeRuntimeTool({
      hostTools: { task },
      taskLaunchers: new Map([
        [
          "task",
          {
            execute: async (_input, options) => ({ actual: options.toolCallId }),
            mode: "local",
            prepare: async () => {},
            preview: (_input, options) => ({ preview: options.toolCallId }),
            reserve: () => {},
            rollback: async (_cause, options) => {
              rolledBack.push(options.toolCallId);
            },
          },
        ],
      ]),
    });
    if (codeMode.execute === undefined) throw new Error("code_mode has no executor");

    await expect(
      codeMode.execute({ js: "return await tools.task({});" }, {
        messages: [],
        toolCallId: "receipt-mismatch",
      } as never),
    ).rejects.toThrow("did not match its preview");
    expect(rolledBack).toEqual(["receipt-mismatch:tool-1"]);
  });
});
