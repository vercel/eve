import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  continueWorkflowSandboxInterrupt: vi.fn(),
  createParkingHostTool: vi.fn((input) => input),
  createWorkflowSandboxTool: vi.fn(),
  getWorkflowSandboxPendingInterrupts: vi.fn(),
  requestWorkflowSandboxInterrupt: vi.fn(),
  unwrapWorkflowSandboxResult: vi.fn(),
}));

vi.mock("#shared/workflow-sandbox.js", () => mocks);

import {
  dynamicWorkflowBridgeRequestLimit,
  runDynamicWorkflowProgramStep,
} from "#execution/dynamic-workflow/program-step.js";
import {
  DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND,
  readDynamicWorkflowCallInterrupt,
  type DynamicWorkflowInput,
} from "#execution/dynamic-workflow/schema.js";

const program: DynamicWorkflowInput = {
  agents: [
    {
      description: "Research.",
      inputSchema: { type: "object" },
      name: "researcher",
      outputSchema: null,
    },
  ],
  continuationSecurity: { signingKey: "key" },
  js: "return tools.researcher({ message: 'x' });",
  maxSubagents: 3,
};

const callPayload = {
  kind: DYNAMIC_WORKFLOW_CALL_INTERRUPT_KIND,
  task: undefined,
  toolInput: { message: "x" },
  toolName: "researcher",
};
const interrupt = { payload: callPayload } as never;

describe("runDynamicWorkflowProgramStep", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the pending subagent calls from a new program", async () => {
    const execute = vi.fn().mockResolvedValue("parked");
    mocks.createWorkflowSandboxTool.mockResolvedValue({ execute });
    mocks.unwrapWorkflowSandboxResult.mockResolvedValue({ interrupt, status: "interrupted" });
    mocks.getWorkflowSandboxPendingInterrupts.mockReturnValue([interrupt]);

    await expect(runDynamicWorkflowProgramStep({ callId: "call", program })).resolves.toEqual({
      interrupt,
      pending: [interrupt],
      status: "interrupted",
    });
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledWith(
      expect.objectContaining({ continuationSecurity: program.continuationSecurity }),
    );
    expect(execute).toHaveBeenCalledWith({ js: program.js }, { toolCallId: "call" });
  });

  it("returns JSON output after a continuation", async () => {
    mocks.continueWorkflowSandboxInterrupt.mockResolvedValue("complete");
    mocks.unwrapWorkflowSandboxResult.mockResolvedValue({
      output: { ok: true },
      status: "completed",
    });

    await expect(
      runDynamicWorkflowProgramStep({
        callId: "call",
        program,
        resume: { interrupt, resolutions: [{ answer: 1 }] },
      }),
    ).resolves.toEqual({ output: { ok: true }, status: "completed" });
  });

  it("validates interrupt payloads", () => {
    expect(readDynamicWorkflowCallInterrupt(interrupt)).toEqual(callPayload);
    expect(() => readDynamicWorkflowCallInterrupt({ payload: { kind: "other" } } as never)).toThrow(
      'Unsupported workflow interrupt kind "other"',
    );
  });

  it("leaves room for a rejected over-budget call", () => {
    expect(dynamicWorkflowBridgeRequestLimit(100)).toBe(256);
    expect(dynamicWorkflowBridgeRequestLimit(256)).toBe(257);
  });
});
