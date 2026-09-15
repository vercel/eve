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

  it("defines a branded tool with a model-visible allowlist and pinned options", () => {
    const definition = workflow({ agents: ["researcher", "reviewer"], maxSubagents: 7 });

    expect(isWorkflowToolDefinition(definition)).toBe(true);
    expect(definition.description).toContain("Available agents: researcher, reviewer.");
    expect(definition.description).toContain("at most 7 agents");
    expect(definition.execute).toBe(executeWorkflowProgram);
    expect(serializeInputSchema(definition.inputSchema)).toMatchObject({
      additionalProperties: false,
      properties: { js: { type: "string" } },
      required: ["js"],
      type: "object",
    });
    expect(readWorkflowProgramOptions(definition)).toEqual({
      agents: ["researcher", "reviewer"],
      maxSubagents: 7,
    });
  });

  it("preserves trusted options in the compiled definition", () => {
    const previousWorkflowId = Reflect.get(executeWorkflowProgram, "workflowId");
    Reflect.set(executeWorkflowProgram, "workflowId", "workflow//test//executeWorkflowProgram");
    try {
      const normalized = normalizeToolDefinition(
        workflow({ agents: ["researcher"], maxSubagents: 4 }),
        "Invalid workflow.",
      );
      expect(normalized).toMatchObject({
        kind: "tool",
        definition: {
          workflowProgram: { agents: ["researcher"], maxSubagents: 4 },
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

  it("validates trusted factory options", () => {
    expect(() => workflow({ agents: [] })).toThrow("between 1 and 128 allowed agents");
    expect(() =>
      workflow({ agents: Array.from({ length: 129 }, (_, index) => `agent-${index}`) }),
    ).toThrow("between 1 and 128 allowed agents");
    expect(() => workflow({ agents: ["researcher", "researcher"] })).toThrow("must be unique");
    expect(() => workflow({ agents: ["researcher"], maxSubagents: 0 })).toThrow(
      "between 1 and 128",
    );
    expect(() => workflow({ agents: ["researcher"], maxSubagents: 129 })).toThrow(
      "between 1 and 128",
    );
  });

  it("routes the pinned executor input to the private JavaScript adapter", async () => {
    mocks.runJsProgram.mockResolvedValue({ ok: true });
    const ctx = { callId: "call" } as never;

    await expect(
      executeWorkflowProgram({ agents: ["researcher"], js: "return 1", maxSubagents: 3 }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(mocks.runJsProgram).toHaveBeenCalledWith("return 1", ctx, {
      agents: ["researcher"],
      maxSubagents: 3,
    });
  });
});
