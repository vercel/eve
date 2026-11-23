import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runJsProgram: vi.fn() }));
vi.mock("#execution/dynamic-workflow/workflow.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runJsProgram: mocks.runJsProgram,
}));

import {
  runWorkflowProgramExecute,
  runWorkflowProgramTask,
} from "#execution/dynamic-workflow/tool.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { workflow } from "#tools/provided/workflow.js";
import { readWorkflowProgramOptions } from "#tools/workflow-program-input.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";
import { serializeInputSchema } from "#tools/schema.js";

describe("workflow", () => {
  beforeEach(() => vi.resetAllMocks());

  it("defines a branded task tool by default with capability guidance", () => {
    const definition = workflow({ maxSubagents: 7 });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.description).toContain("ctx.agents");
    expect(definition.description).toContain(
      "ctx.agent(name, { message: string, outputSchema?: object, model?: string | object, files?: [{ url, mediaType, filename? }] })",
    );
    expect(definition.description).toContain("ctx.ask(");
    expect(definition.description).toContain("ctx.sleep(seconds)");
    expect(definition.description).toContain("ctx.progress(update)");
    expect(definition.description).toContain("console.log");
    expect(definition.description).toContain("background as a task");
    expect(definition.description).toContain("at most 7 agents");
    expect(definition.task).toBe(runWorkflowProgramTask);
    expect(definition.toModelOutput).toBeTypeOf("function");

    const inputSchema = serializeInputSchema(definition.inputSchema);
    expect(inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        js: {
          description: expect.stringContaining(
            "Supply only the body, without a surrounding function declaration or arrow function",
          ),
          type: "string",
        },
      },
      required: ["js"],
      type: "object",
    });
    expect(readWorkflowProgramOptions(definition)).toEqual({ maxSubagents: 7 });
  });

  it("supports foreground execute mode and preserves only the trusted call budget in compiled definitions", () => {
    const executeDefinition = workflow({ maxSubagents: 4, mode: "execute" });
    expect(executeDefinition.execute).toBe(runWorkflowProgramExecute);
    expect(executeDefinition.description).toContain("Runs in the foreground");
    expect(readWorkflowProgramOptions(executeDefinition)).toEqual({ maxSubagents: 4 });

    const entries = [
      { definition: workflow({ maxSubagents: 4 }), fn: runWorkflowProgramTask, id: "task" },
      { definition: executeDefinition, fn: runWorkflowProgramExecute, id: "execute" },
    ];
    for (const entry of entries) {
      const previousWorkflowId = Reflect.get(entry.fn, "workflowId");
      Reflect.set(entry.fn, "workflowId", `workflow//test//${entry.id}`);
      try {
        const normalized = normalizeToolDefinition(entry.definition, "Invalid workflow.");
        expect(normalized).toMatchObject({
          kind: "tool",
          definition: {
            workflow: { entryPoint: entry.id },
            workflowProgram: { maxSubagents: 4 },
          },
        });
      } finally {
        if (previousWorkflowId === undefined) {
          Reflect.deleteProperty(entry.fn, "workflowId");
        } else {
          Reflect.set(entry.fn, "workflowId", previousWorkflowId);
        }
      }
    }
  });

  it("defaults and validates options", () => {
    expect(readWorkflowProgramOptions(workflow())).toEqual({ maxSubagents: 100 });
    expect(() => workflow({ maxSubagents: 0 })).toThrow("between 1 and 128");
    expect(() => workflow({ maxSubagents: 129 })).toThrow("between 1 and 128");
    expect(() => workflow({ mode: "serve" as never })).toThrow('mode must be "task" or "execute"');
    expect(() => workflow({ tools: true } as never)).toThrow(
      'workflow({ tools: true }) requires mode: "execute".',
    );
    expect(() => workflow({ mode: "task", tools: true } as never)).toThrow(
      'workflow({ tools: true }) requires mode: "execute".',
    );
    expect(() => workflow({ mode: "execute", tools: "yes" as never })).toThrow(
      "workflow tools must be a boolean.",
    );
  });

  it("supports opt-in tool calling with mode: execute and tools: true", () => {
    const definition = workflow({ maxSubagents: 6, mode: "execute", tools: true });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.execute).toBe(runWorkflowProgramExecute);
    expect(definition.description).toContain("tools.<name>(input)");
    expect(definition.description).toContain("search({ query })");
    expect(definition.description).toContain("ctx.agent(name, { message, outputSchema?, model? })");
    expect(definition.description).toContain("at most 6 agents");
    expect(readWorkflowProgramOptions(definition)).toEqual({ maxSubagents: 6, tools: true });

    const previousWorkflowId = Reflect.get(runWorkflowProgramExecute, "workflowId");
    Reflect.set(runWorkflowProgramExecute, "workflowId", "workflow//test//execute-tools");
    try {
      const normalized = normalizeToolDefinition(definition, "Invalid workflow.");
      expect(normalized).toMatchObject({
        kind: "tool",
        definition: {
          workflow: { entryPoint: "execute" },
          workflowProgram: { maxSubagents: 6, tools: true },
        },
      });
    } finally {
      if (previousWorkflowId === undefined) {
        Reflect.deleteProperty(runWorkflowProgramExecute, "workflowId");
      } else {
        Reflect.set(runWorkflowProgramExecute, "workflowId", previousWorkflowId);
      }
    }
  });

  it("caps model-facing outputs over 10,000 estimated tokens while leaving smaller outputs untouched", async () => {
    const definition = workflow();
    const project = definition.toModelOutput!;

    expect(await project({ ok: true })).toEqual({ type: "json", value: { ok: true } });
    expect(await project("short")).toEqual({ type: "text", value: "short" });

    const large = `HEAD_${"a".repeat(60_000)}_TAIL`;
    const projected = await project(large);
    expect(projected.type).toBe("text");
    if (projected.type === "text") {
      expect(projected.value.startsWith("HEAD_")).toBe(true);
      expect(projected.value.endsWith("_TAIL")).toBe(true);
      expect(projected.value).toContain("over 10000 tokens");
      expect(projected.value.length).toBeLessThan(large.length);
    }

    const multibyte = `START_${"漢".repeat(20_000)}_END`;
    const projectedUtf8 = await project(multibyte);
    expect(projectedUtf8.type).toBe("text");
    if (projectedUtf8.type === "text") {
      expect(projectedUtf8.value.startsWith("START_")).toBe(true);
      expect(projectedUtf8.value.endsWith("_END")).toBe(true);
      expect(projectedUtf8.value).toContain("characters left out");
    }
  });

  it("routes pinned task and execute entry points to runJsProgram", async () => {
    mocks.runJsProgram.mockResolvedValue({ ok: true });
    const ctx = { callId: "call" } as never;

    await expect(runWorkflowProgramTask({ js: "return 1", maxSubagents: 3 }, ctx)).resolves.toEqual(
      { ok: true },
    );
    await expect(
      runWorkflowProgramExecute({ js: "return 2", maxSubagents: 5 }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(mocks.runJsProgram).toHaveBeenNthCalledWith(1, "return 1", ctx, { maxSubagents: 3 });
    expect(mocks.runJsProgram).toHaveBeenNthCalledWith(2, "return 2", ctx, { maxSubagents: 5 });
  });
});
