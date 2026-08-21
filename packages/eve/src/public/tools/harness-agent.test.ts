import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHarnessAgent } from "#execution/harness-agent/run.js";
import type { ToolContext } from "#public/definitions/tool.js";
import { createHarnessAgentTool, defineHarnessAgentTool } from "#public/tools/harness-agent.js";
import type { HarnessAgentHarness } from "#execution/harness-agent/types.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import { serializeInputSchema } from "#shared/tool-schema.js";

vi.mock("#execution/harness-agent/run.js", () => ({
  runHarnessAgent: vi.fn(),
}));

const sandbox = { id: "sandbox", stop: async () => {} } as RuntimeSandboxSession;

function createContext(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call_1",
    getSandbox: vi.fn().mockResolvedValue(sandbox),
    getSkill() {
      throw new Error("unused");
    },
    async getToken() {
      return { token: "unused" };
    },
    requireAuth() {
      throw new Error("unused");
    },
    session: {
      auth: { current: null, initiator: null },
      id: "session",
      turn: { id: "turn_1", sequence: 1 },
    },
    toolName: "harness_agent",
  };
}

beforeEach(() => {
  vi.mocked(runHarnessAgent).mockReset();
});

describe("defineHarnessAgentTool", () => {
  it("exposes serializable settings without low-level harness controls", () => {
    const tool = defineHarnessAgentTool();
    expect(
      (tool.inputSchema as { readonly "~standard": { readonly vendor: string } })["~standard"]
        .vendor,
    ).toBe("zod");
    const schema = serializeInputSchema(tool.inputSchema);
    const properties = schema.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual([
      "harness",
      "model",
      "task",
      "id",
      "instructions",
      "skills",
      "workingDirectory",
    ]);
    expect(properties).not.toHaveProperty("toolApproval");
    expect(properties).not.toHaveProperty("permissionMode");
    expect(properties).not.toHaveProperty("activeTools");
    expect(properties).not.toHaveProperty("inactiveTools");
    expect(properties).not.toHaveProperty("timeout");
    expect(properties).not.toHaveProperty("debug");
    expect(tool.approval).toBeTypeOf("function");
  });

  it("runs the selected harness in the current sandbox", async () => {
    vi.mocked(runHarnessAgent).mockResolvedValue("done");
    const context = createContext();
    const tool = defineHarnessAgentTool();

    await expect(
      tool.execute(
        {
          harness: "codex",
          instructions: "Keep the change focused.",
          model: "gpt-5.4-codex",
          task: "Implement the change.",
          workingDirectory: "packages/eve",
        },
        context,
      ),
    ).resolves.toBe("done");

    expect(runHarnessAgent).toHaveBeenCalledWith({
      abortSignal: context.abortSignal,
      harness: "codex",
      model: "gpt-5.4-codex",
      sandbox,
      settings: expect.objectContaining({
        instructions: "Keep the change focused.",
        workingDirectory: "packages/eve",
      }),
      task: "Implement the change.",
    });
  });
});

describe("createHarnessAgentTool", () => {
  it("exposes only task and an allowlisted harness", () => {
    const tool = createHarnessAgentTool({
      harnesses: ["claude-code", "codex"],
      models: { codex: "gpt-5.4-codex" },
    });
    expect(
      (tool.inputSchema as { readonly "~standard": { readonly vendor: string } })["~standard"]
        .vendor,
    ).toBe("zod");
    const schema = serializeInputSchema(tool.inputSchema);

    expect(schema.properties).toEqual({
      harness: {
        description: "Preconfigured coding harness to run.",
        enum: ["claude-code", "codex"],
        type: "string",
      },
      task: {
        description: "Task for the coding harness to complete.",
        type: "string",
      },
    });
    expect(tool.approval).toBeTypeOf("function");
  });

  it("uses the same structured schema for the eve tool and harness result", async () => {
    const outputSchema = z.object({ summary: z.string() });
    const output = { summary: "Reviewed." };
    vi.mocked(runHarnessAgent).mockResolvedValue(output);
    const tool = createHarnessAgentTool({
      harnesses: ["claude-code"],
      instructions: "Review the change.",
      outputSchema,
    });
    const context = createContext();

    await expect(
      tool.execute({ harness: "claude-code", task: "Review this." }, context),
    ).resolves.toEqual(output);
    expect(tool.outputSchema).toBe(outputSchema);
    expect(runHarnessAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema,
        settings: expect.objectContaining({ instructions: "Review the change." }),
      }),
    );
  });

  it("rejects empty allowlists and model settings for disabled harnesses", () => {
    expect(() => createHarnessAgentTool({ harnesses: [] })).toThrow("at least one enabled harness");
    expect(() => createHarnessAgentTool({ harnesses: ["unknown" as HarnessAgentHarness] })).toThrow(
      'Unknown HarnessAgent harness "unknown"',
    );
    expect(() =>
      createHarnessAgentTool({
        harnesses: ["codex"],
        models: { "claude-code": "claude-opus-4-1" },
      }),
    ).toThrow('disabled HarnessAgent harness "claude-code"');
  });
});
