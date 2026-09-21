import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runJsProgram: vi.fn() }));
vi.mock("#execution/dynamic-workflow/workflow.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runJsProgram: mocks.runJsProgram,
}));

import { executeWorkflowProgram } from "#execution/dynamic-workflow/tool.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";
import { workflow } from "#tools/provided/workflow.js";
import { readWorkflowProgramOptions } from "#tools/workflow-program-input.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";
import { serializeInputSchema } from "#tools/schema.js";

describe("workflow", () => {
  beforeEach(() => vi.resetAllMocks());

  it("defines a branded tool with detailed function-body and agent result guidance", () => {
    const definition = workflow({ maxSubagents: 7 });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.description).toContain(
      "ctx.agent(nameOrHandle, { message: string, agentId?: string, outputSchema?: object })",
    );
    expect(definition.description).toContain(
      "resolves directly to the child's JSON-serializable output",
    );
    expect(definition.description).toContain("does not return an agent metadata wrapper");
    expect(definition.description).toContain("owning agent resolves the target");
    expect(definition.description).toContain(
      'return await ctx.agent("researcher", { message: "Describe the task" })',
    );
    expect(definition.description).not.toContain("Available agents");
    expect(definition.description).toContain("at most 7 agents");
    expect(definition.execute).toBe(executeWorkflowProgram);

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
    expect(inputSchema).toMatchObject({
      properties: {
        js: {
          description: expect.stringContaining(
            "resolves directly to the child's JSON-serializable output",
          ),
        },
      },
    });
    expect(readWorkflowProgramOptions(definition)).toEqual({ maxSubagents: 7 });
  });

  it("preserves the trusted budget in the compiled definition", () => {
    const previousWorkflowId = Reflect.get(executeWorkflowProgram, "workflowId");
    Reflect.set(executeWorkflowProgram, "workflowId", "workflow//test//executeWorkflowProgram");
    try {
      const normalized = normalizeToolDefinition(
        workflow({ maxSubagents: 4 }),
        "Invalid workflow.",
      );
      expect(normalized).toMatchObject({
        kind: "tool",
        definition: {
          workflowProgram: { maxSubagents: 4 },
        },
      });
    } finally {
      if (previousWorkflowId === undefined) {
        Reflect.deleteProperty(executeWorkflowProgram, "workflowId");
      } else {
        Reflect.set(executeWorkflowProgram, "workflowId", previousWorkflowId);
      }
    }
  });

  it("defaults and validates the trusted call budget", () => {
    expect(readWorkflowProgramOptions(workflow())).toEqual({ maxSubagents: 100 });
    expect(() => workflow({ maxSubagents: 0 })).toThrow("between 1 and 128");
    expect(() => workflow({ maxSubagents: 129 })).toThrow("between 1 and 128");
  });

  it("routes pinned executor input to the private JavaScript adapter", async () => {
    mocks.runJsProgram.mockResolvedValue({ ok: true });
    const ctx = { callId: "call" } as never;

    await expect(executeWorkflowProgram({ js: "return 1", maxSubagents: 3 }, ctx)).resolves.toEqual(
      { ok: true },
    );
    expect(mocks.runJsProgram).toHaveBeenCalledWith("return 1", ctx, {
      maxSubagents: 3,
    });
  });
});
