import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  continueWorkflowSandboxInterrupt: vi.fn(),
  createParkingHostTool: vi.fn((input) => input),
  createWorkflowSandboxTool: vi.fn(),
  getWorkflowSandboxPendingInterrupts: vi.fn(),
  unwrapWorkflowSandboxResult: vi.fn(),
}));

vi.mock("#shared/workflow-sandbox.js", () => mocks);

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";
import {
  WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND,
  readWorkflowProgramCallInterrupt,
  type WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";

const program: WorkflowProgramInput = {
  continuationSecurity: { signingKey: "key" },
  js: "return ctx.agent('researcher', { message: 'x' });",
  maxSubagents: 3,
};

const callPayload = {
  kind: WORKFLOW_PROGRAM_CALL_INTERRUPT_KIND,
  task: undefined,
  toolInput: { input: { message: "x" }, target: "researcher" },
  toolName: "agent" as const,
};
const interrupt = { payload: callPayload } as never;

describe("runWorkflowProgramStep", () => {
  beforeEach(() => vi.resetAllMocks());

  it("exposes one restricted agent bridge and returns pending calls", async () => {
    const execute = vi.fn().mockResolvedValue("parked");
    mocks.createWorkflowSandboxTool.mockResolvedValue({ execute });
    mocks.unwrapWorkflowSandboxResult.mockResolvedValue({ interrupt, status: "interrupted" });
    mocks.getWorkflowSandboxPendingInterrupts.mockReturnValue([interrupt]);

    await expect(runWorkflowProgramStep({ callId: "call", program })).resolves.toEqual({
      interrupt,
      pending: [interrupt],
      status: "interrupted",
    });
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeRequestLimit: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
        continuationSecurity: program.continuationSecurity,
        hostTools: { agent: expect.anything() },
      }),
    );
    expect(mocks.createParkingHostTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      {
        js: expect.stringContaining("agent: (target, input) => tools.agent({ target, input })"),
      },
      { toolCallId: "call" },
    );
  });

  it("returns JSON output after ordered continuation resolutions", async () => {
    mocks.continueWorkflowSandboxInterrupt.mockResolvedValue("complete");
    mocks.unwrapWorkflowSandboxResult.mockResolvedValue({
      output: { ok: true },
      status: "completed",
    });

    await expect(
      runWorkflowProgramStep({
        callId: "call",
        program,
        resume: {
          interrupt,
          resolutions: [{ status: "completed", output: { answer: 1 } }],
        },
      }),
    ).resolves.toEqual({ output: { ok: true }, status: "completed" });
    expect(mocks.continueWorkflowSandboxInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeRequestLimit: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT }),
    );
  });

  it("validates interrupt payloads", () => {
    expect(readWorkflowProgramCallInterrupt(interrupt)).toEqual(callPayload);
    expect(() => readWorkflowProgramCallInterrupt({ payload: { kind: "other" } } as never)).toThrow(
      'Unsupported workflow program interrupt kind "other"',
    );
  });
});
